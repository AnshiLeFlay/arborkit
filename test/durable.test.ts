import { describe, expect, it } from "vitest";
import {
  ConfigMismatchError,
  IdempotencyConflictError,
  MemoryDurableStore,
  MockEmbeddingPort,
  StaleArtifactError,
  configFingerprint,
  createArbor,
  durableRequestHash,
  openDurableArbor,
  sizeBasedDecision,
  type DurableCommitRequest,
  type VectorIndexEntry,
  MemoryVectorIndex,
} from "../src/index";

const config = {
  decomposition: { id: "size-based", version: "1" },
  registry: { id: "docs", version: "1" },
};
const arborOpts = (initial?: Record<string, unknown>) => ({
  ...(initial !== undefined ? { initial: initial as never } : {}),
  decompose: sizeBasedDecision(1),
});

describe("durable persistence", () => {
  it("commits events and restores an acknowledged mutation", async () => {
    const store = new MemoryDurableStore();
    const first = await openDurableArbor({ artifactId: "demo", store, config, arbor: arborOpts({ docs: {} }) });
    const committed = await first.transact({}, (arbor) => arbor.toolset().patch(
      { path: "/docs" },
      { op: "insert", key: "a", value: "A" },
    ));
    expect(committed.version).toBe(1);

    const restored = await openDurableArbor({ artifactId: "demo", store, config, arbor: arborOpts() });
    expect(restored.arbor.tree.toJson()).toEqual({ docs: { a: "A" } });
    expect(restored.version).toBe(1);
  });

  it("deduplicates an idempotent retry without invoking its callback", async () => {
    const store = new MemoryDurableStore();
    const session = await openDurableArbor({ artifactId: "idem", store, config, arbor: arborOpts({ count: 0 }) });
    const hash = durableRequestHash({ op: "set-count", value: 1 });
    const first = await session.transact({ idempotencyKey: "request-1", requestHash: hash }, async (arbor) => {
      return arbor.toolset().patch({ path: "/count" }, { op: "set", value: 1 });
    });
    let invoked = false;
    const second = await session.transact({ idempotencyKey: "request-1", requestHash: hash }, () => {
      invoked = true;
      return null;
    });
    expect(first.replayed).toBe(false);
    expect(second.replayed).toBe(true);
    expect(second.value).toEqual(first.value);
    expect(invoked).toBe(false);
    expect(session.version).toBe(1);
  });

  it("rejects reuse of an idempotency key for another request", async () => {
    const store = new MemoryDurableStore();
    const session = await openDurableArbor({ artifactId: "idem-conflict", store, config });
    await session.transact(
      { idempotencyKey: "same", requestHash: durableRequestHash({ n: 1 }) },
      () => null,
    );
    await expect(session.transact(
      { idempotencyKey: "same", requestHash: durableRequestHash({ n: 2 }) },
      () => null,
    )).rejects.toBeInstanceOf(IdempotencyConflictError);
  });

  it("rolls back and reloads after a competing writer wins CAS", async () => {
    const store = new MemoryDurableStore();
    const a = await openDurableArbor({ artifactId: "race", store, config, arbor: arborOpts({ value: 0 }) });
    const b = await openDurableArbor({ artifactId: "race", store, config, arbor: arborOpts() });
    await a.transact({}, (arbor) => arbor.toolset().patch({ path: "/value" }, { op: "set", value: 1 }));
    await expect(b.transact({}, (arbor) =>
      arbor.toolset().patch({ path: "/value" }, { op: "set", value: 2 }),
    )).rejects.toBeInstanceOf(StaleArtifactError);
    expect(b.arbor.tree.toJson()).toEqual({ value: 1 });
    expect(b.version).toBe(1);
  });

  it("rolls back local state when durable commit fails", async () => {
    class FailingStore extends MemoryDurableStore {
      fail = false;
      override async commit(request: DurableCommitRequest) {
        if (this.fail) throw new Error("database offline");
        return super.commit(request);
      }
    }
    const store = new FailingStore();
    const session = await openDurableArbor({ artifactId: "rollback", store, config, arbor: arborOpts({ value: 0 }) });
    store.fail = true;
    await expect(session.transact({}, (arbor) =>
      arbor.toolset().patch({ path: "/value" }, { op: "set", value: 1 }),
    )).rejects.toThrow("database offline");
    expect(session.arbor.tree.toJson()).toEqual({ value: 0 });
    expect(session.arbor.log.length()).toBe(0);
  });

  it("validates the stored configuration fingerprint", async () => {
    const store = new MemoryDurableStore();
    await openDurableArbor({ artifactId: "configured", store, config });
    await expect(openDurableArbor({
      artifactId: "configured",
      store,
      config: { ...config, registry: { id: "docs", version: "2" } },
    })).rejects.toBeInstanceOf(ConfigMismatchError);
    expect(configFingerprint(config)).toBe(configFingerprint({ registry: config.registry, decomposition: config.decomposition }));
  });

  it("checkpoints a compacted history window and restores it", async () => {
    const store = new MemoryDurableStore();
    const session = await openDurableArbor({ artifactId: "compact", store, config, arbor: arborOpts({ value: 0 }) });
    for (let value = 1; value <= 5; value += 1) {
      await session.transact({}, (arbor) => arbor.toolset().patch({ path: "/value" }, { op: "set", value }));
    }
    await session.checkpoint({ keepLast: 2 });
    const restored = await openDurableArbor({ artifactId: "compact", store, config, arbor: arborOpts() });
    expect(restored.arbor.tree.toJson()).toEqual({ value: 5 });
    expect(restored.arbor.log.baseSeqValue()).toBe(3);
    expect(restored.arbor.log.entries()).toHaveLength(2);
  });
});

describe("persistent vector safety", () => {
  it("does not mark a node fresh when remote upsert fails", async () => {
    class FailingVectors extends MemoryVectorIndex {
      override async upsert(_entries: VectorIndexEntry[]): Promise<void> {
        throw new Error("vector backend offline");
      }
    }
    const arbor = createArbor({
      initial: { text: "hello" },
      decompose: sizeBasedDecision(1),
      embedding: new MockEmbeddingPort(),
      vectors: new FailingVectors(),
    });
    await expect(arbor.index!.reindex()).rejects.toThrow("vector backend offline");
    const node = arbor.addressing.byPath("/text")!;
    expect(node.meta.embedding.state).toBe("stale");
    expect(arbor.index!.staleCount()).toBeGreaterThan(0);
  });
});
