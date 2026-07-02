import { describe, it, expect } from "vitest";
import { z } from "zod";
import { createArbor, restoreArbor } from "../src/arbor";
import { TypeRegistry } from "../src/type-registry";
import { zodValidate } from "../src/zod-adapter";
import { MockEmbeddingPort } from "../src/embedding-port";
import { MemoryStorage } from "../src/storage";
import { MemoryDeltaStorage } from "../src/delta-storage";
import { SeqIdGen } from "../src/ids";
import { FixedClock } from "../src/clock";
import { sizeBasedDecision } from "../src/decompose";

const testDeps = { idGen: () => new SeqIdGen(), clock: () => new FixedClock(0), decompose: () => sizeBasedDecision(1) };
function opts(extra: object = {}) {
  return { idGen: testDeps.idGen(), clock: testDeps.clock(), decompose: testDeps.decompose(), ...extra };
}

describe("M15 createArbor facade", () => {
  it("one call wires tree/mutator/toolset; agents work immediately", async () => {
    const arbor = createArbor(opts({ initial: { docs: {} } }));
    const agent = arbor.toolset({ owner: "w1", writeScope: "/docs", readScope: "/docs" });
    const w = await agent.patch({ path: "/docs" }, { op: "insert", key: "a", value: "hello" });
    expect(w.ok).toBe(true);
    const r = await agent.get({ path: "/docs/a" });
    expect(r.ok && r.value.content).toBe("hello");
    const esc = await agent.patch({ path: "" }, { op: "set", value: null });
    expect(esc.ok).toBe(false); // scope enforced through the facade
    expect(arbor.log.length()).toBe(1);
    expect(arbor.replay.getAt("/docs/a", 1)).toBe("hello");
  });

  it("registry wires validation AND type-aware decomposition", () => {
    const registry = new TypeRegistry();
    registry.register("doc", { validate: zodValidate(z.object({ body: z.string() })), decompose: "opaque" });
    const arbor = createArbor(opts({ registry, initial: { docs: {} } }));
    expect(() => arbor.mutator.insert({ path: "/docs" }, "bad", { body: 42 }, { type: "doc" })).toThrow();
    arbor.mutator.insert({ path: "/docs" }, "good", { body: "ok" }, { type: "doc" });
    expect(arbor.addressing.byPath("/docs/good")!.kind).toBe("leaf"); // decompose:"opaque" honored
  });

  it("embedding option wires the semantic index end-to-end", async () => {
    const arbor = createArbor(opts({ initial: { docs: {} }, embedding: new MockEmbeddingPort() }));
    arbor.mutator.insert({ path: "/docs" }, "a", "the quick brown fox");
    await arbor.index!.reindex();
    const hits = await arbor.index!.search("the quick brown fox");
    expect(hits.results[0]!.path).toBe("/docs/a");
  });

  it("save + restoreArbor round-trips (storage), search intact, and post-restore mutation is SAFE with a deterministic idGen", async () => {
    const storage = new MemoryStorage();
    const a1 = createArbor(opts({ initial: { docs: {} }, embedding: new MockEmbeddingPort(), storage }));
    a1.mutator.insert({ path: "/docs" }, "a", "persist me");
    await a1.index!.reindex();
    await a1.save();

    const a2 = await restoreArbor(opts({ embedding: new MockEmbeddingPort(), storage }));
    expect(a2).not.toBeNull();
    expect(a2!.tree.toJson()).toEqual({ docs: { a: "persist me" } });
    const hits = await a2!.index!.search("persist me");
    expect(hits.results[0]!.path).toBe("/docs/a");
    // known-minor (a): fresh SeqIdGen would mint colliding ids — the facade guards it
    a2!.mutator.insert({ path: "/docs" }, "b", "post-restore");
    expect(a2!.tree.toJson()).toEqual({ docs: { a: "persist me", b: "post-restore" } });
    expect(a2!.addressing.pathOf(a2!.addressing.byPath("/docs/b")!.id)).toBe("/docs/b"); // no cycle
  });

  it("delta lifecycle: saveDelta appends, checkpoint compacts+snapshots, restore prefers delta", async () => {
    const delta = new MemoryDeltaStorage();
    const a1 = createArbor(opts({ initial: { page: "" }, delta }));
    await a1.checkpoint(); // baseline snapshot @ v0
    for (let i = 1; i <= 10; i++) a1.mutator.set({ path: "/page" }, `v${i}`);
    await a1.saveDelta();
    expect((await delta.loadDelta()).journal.length).toBe(10);

    await a1.checkpoint({ keepLast: 3 }); // compact + snapshot, journal cleared
    const bundle = await delta.loadDelta();
    expect(bundle.checkpoint!.events.length).toBe(3);
    expect(bundle.journal.length).toBe(0);

    const a2 = await restoreArbor(opts({ delta }));
    expect(a2!.tree.toJson()).toEqual({ page: "v10" });
    expect(a2!.log.length()).toBe(10);
  });

  it("restoreArbor returns null when nothing was persisted; save without storage throws structured", async () => {
    expect(await restoreArbor(opts({ storage: new MemoryStorage() }))).toBeNull();
    const arbor = createArbor(opts());
    await expect(arbor.save()).rejects.toThrow();
  });
});
