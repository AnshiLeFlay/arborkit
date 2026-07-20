import { createHash } from "node:crypto";
import type { Json } from "./types";
import type { MutationEvent } from "./event-log";
import type { StoredArtifact } from "./storage";
import { serializeArtifact } from "./storage";
import type { DeltaStoragePort } from "./delta-storage";
import { createArbor, restoreArbor, type Arbor, type ArborOpts } from "./arbor";
import {
  ConfigMismatchError,
  IdempotencyConflictError,
  InvalidOpError,
  StaleArtifactError,
} from "./errors";

export interface ArtifactConfigIdentity {
  decomposition: { id: string; version: string };
  registry?: { id: string; version: string };
  embedding?: { provider: string; model: string; dimensions: number };
}

export interface DurableIdempotencyRecord {
  requestHash: string;
  result: unknown;
  version: number;
}

export interface DurableLoadResult {
  artifactId: string;
  checkpoint: StoredArtifact;
  journal: MutationEvent[];
  currentVersion: number;
  config: ArtifactConfigIdentity;
  configFingerprint: string;
}

export interface DurableCreateRequest {
  artifactId: string;
  checkpoint: StoredArtifact;
  config: ArtifactConfigIdentity;
  configFingerprint: string;
}

export interface DurableCommitRequest {
  artifactId: string;
  expectedVersion: number;
  events: readonly MutationEvent[];
  idempotencyKey?: string;
  requestHash?: string;
  result?: unknown;
}

export interface DurableCommitResult {
  version: number;
  replayed: boolean;
  result?: unknown;
}

export interface DurableCheckpointRequest {
  artifactId: string;
  expectedVersion: number;
  checkpoint: StoredArtifact;
}

/** Authoritative, multi-artifact persistence. Implementations must make each
 *  method atomic at the storage boundary. */
export interface DurableStorePort {
  load(artifactId: string): Promise<DurableLoadResult | null>;
  /** Create iff absent. Returns false when another process created it first. */
  create(request: DurableCreateRequest): Promise<boolean>;
  lookupIdempotency(artifactId: string, key: string): Promise<DurableIdempotencyRecord | null>;
  commit(request: DurableCommitRequest): Promise<DurableCommitResult>;
  checkpoint(request: DurableCheckpointRequest): Promise<void>;
  close?(): Promise<void>;
}

interface MemoryDurableState {
  checkpoint: StoredArtifact;
  journal: MutationEvent[];
  currentVersion: number;
  config: ArtifactConfigIdentity;
  configFingerprint: string;
  idempotency: Map<string, DurableIdempotencyRecord>;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function checkpointVersion(checkpoint: StoredArtifact): number {
  return (checkpoint.baseSeq ?? 0) + checkpoint.events.length;
}

function assertArtifactId(artifactId: string): void {
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/.test(artifactId)) {
    throw new TypeError("artifactId must be URL-safe and contain only letters, digits, '.', '_' or '-'");
  }
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (typeof value !== "object" || value === null) return value;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    const item = (value as Record<string, unknown>)[key];
    if (item !== undefined) out[key] = canonical(item);
  }
  return out;
}

export function configFingerprint(config: ArtifactConfigIdentity): string {
  return createHash("sha256").update(JSON.stringify(canonical(config))).digest("hex");
}

/** Deterministic in-memory reference implementation used by tests and embedded callers. */
export class MemoryDurableStore implements DurableStorePort {
  private readonly artifacts = new Map<string, MemoryDurableState>();

  async load(artifactId: string): Promise<DurableLoadResult | null> {
    const state = this.artifacts.get(artifactId);
    if (!state) return null;
    return {
      artifactId,
      checkpoint: clone(state.checkpoint),
      journal: clone(state.journal),
      currentVersion: state.currentVersion,
      config: clone(state.config),
      configFingerprint: state.configFingerprint,
    };
  }

  async create(request: DurableCreateRequest): Promise<boolean> {
    assertArtifactId(request.artifactId);
    if (this.artifacts.has(request.artifactId)) return false;
    this.artifacts.set(request.artifactId, {
      checkpoint: clone(request.checkpoint),
      journal: [],
      currentVersion: checkpointVersion(request.checkpoint),
      config: clone(request.config),
      configFingerprint: request.configFingerprint,
      idempotency: new Map(),
    });
    return true;
  }

  async lookupIdempotency(artifactId: string, key: string): Promise<DurableIdempotencyRecord | null> {
    const record = this.artifacts.get(artifactId)?.idempotency.get(key);
    return record ? clone(record) : null;
  }

  async commit(request: DurableCommitRequest): Promise<DurableCommitResult> {
    const state = this.artifacts.get(request.artifactId);
    if (!state) throw new InvalidOpError(`Artifact not found: ${request.artifactId}`);
    if (request.idempotencyKey !== undefined) {
      if (request.requestHash === undefined) {
        throw new InvalidOpError("requestHash is required with idempotencyKey");
      }
      const existing = state.idempotency.get(request.idempotencyKey);
      if (existing) {
        if (existing.requestHash !== request.requestHash) {
          throw new IdempotencyConflictError(request.idempotencyKey);
        }
        return { version: existing.version, replayed: true, result: clone(existing.result) };
      }
    }
    if (state.currentVersion !== request.expectedVersion) {
      throw new StaleArtifactError(request.artifactId, request.expectedVersion, state.currentVersion);
    }
    for (const [index, event] of request.events.entries()) {
      const expectedSeq = request.expectedVersion + index;
      if (event.seq !== expectedSeq) {
        throw new InvalidOpError(`Non-contiguous durable commit: expected event ${expectedSeq}, got ${event.seq}`);
      }
    }
    state.journal.push(...clone([...request.events]));
    state.currentVersion += request.events.length;
    if (request.idempotencyKey !== undefined) {
      const record: DurableIdempotencyRecord = {
        requestHash: request.requestHash!,
        result: clone(request.result),
        version: state.currentVersion,
      };
      state.idempotency.set(request.idempotencyKey, record);
    }
    return { version: state.currentVersion, replayed: false, result: clone(request.result) };
  }

  async checkpoint(request: DurableCheckpointRequest): Promise<void> {
    const state = this.artifacts.get(request.artifactId);
    if (!state) throw new InvalidOpError(`Artifact not found: ${request.artifactId}`);
    if (state.currentVersion !== request.expectedVersion) {
      throw new StaleArtifactError(request.artifactId, request.expectedVersion, state.currentVersion);
    }
    if (checkpointVersion(request.checkpoint) !== request.expectedVersion) {
      throw new InvalidOpError("Checkpoint version does not match expectedVersion");
    }
    state.checkpoint = clone(request.checkpoint);
    state.journal = [];
  }
}

export type VectorRecoveryPolicy = "verify" | "trust" | "rebuild";

export interface OpenDurableArborOptions {
  artifactId: string;
  store: DurableStorePort;
  config: ArtifactConfigIdentity;
  arbor?: Omit<ArborOpts, "storage" | "delta">;
  createIfMissing?: boolean;
  vectorRecovery?: VectorRecoveryPolicy;
  maxIdempotencyResultChars?: number;
  closeStoreOnClose?: boolean;
}

export interface DurableTransactionOptions {
  idempotencyKey?: string;
  requestHash?: string;
}

export interface DurableTransactionResult<T> {
  value: T;
  version: number;
  replayed: boolean;
}

export class DurableArborSession {
  readonly kind = "durable-arbor-session" as const;
  private current: Arbor;
  private currentVersion: number;
  private tail: Promise<void> = Promise.resolve();
  private closed = false;

  constructor(private readonly options: Required<Pick<OpenDurableArborOptions,
    "artifactId" | "store" | "config" | "vectorRecovery" | "maxIdempotencyResultChars" | "closeStoreOnClose">> &
    { arbor: Omit<ArborOpts, "storage" | "delta"> }, arbor: Arbor, version: number) {
    this.current = arbor;
    this.currentVersion = version;
  }

  /** Current facade for reads. Mutations must only occur inside `transact`. */
  get arbor(): Arbor {
    return this.current;
  }

  get version(): number {
    return this.currentVersion;
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.tail.then(operation, operation);
    this.tail = run.then(() => undefined, () => undefined);
    return run;
  }

  private assertOpen(): void {
    if (this.closed) throw new InvalidOpError("DurableArborSession is closed");
  }

  private async restoreLoaded(loaded: DurableLoadResult): Promise<void> {
    const expected = configFingerprint(this.options.config);
    if (loaded.configFingerprint !== expected) {
      throw new ConfigMismatchError(loaded.configFingerprint, expected);
    }
    const delta: DeltaStoragePort = {
      writeCheckpoint: async () => { throw new InvalidOpError("read-only restore adapter"); },
      appendEvents: async () => { throw new InvalidOpError("read-only restore adapter"); },
      loadDelta: async () => ({ checkpoint: clone(loaded.checkpoint), journal: clone(loaded.journal) }),
    };
    const restored = await restoreArbor({ ...this.options.arbor, delta });
    if (!restored) throw new InvalidOpError(`Artifact ${loaded.artifactId} has no checkpoint`);
    this.current = restored;
    this.currentVersion = loaded.currentVersion;
    if (restored.index) {
      if (this.options.vectorRecovery === "trust") {
        // Caller explicitly accepts the durable backend's state.
      } else if (this.options.vectorRecovery === "rebuild") {
        restored.index.invalidateFresh();
      } else {
        await restored.index.reconcilePersistent();
      }
    }
  }

  private async reloadUnlocked(): Promise<void> {
    const loaded = await this.options.store.load(this.options.artifactId);
    if (!loaded) throw new InvalidOpError(`Artifact not found: ${this.options.artifactId}`);
    await this.restoreLoaded(loaded);
  }

  async reload(): Promise<void> {
    this.assertOpen();
    return this.enqueue(() => this.reloadUnlocked());
  }

  async transact<T>(
    options: DurableTransactionOptions,
    mutate: (arbor: Arbor) => T | Promise<T>,
  ): Promise<DurableTransactionResult<T>> {
    this.assertOpen();
    return this.enqueue(async () => {
      if (options.idempotencyKey !== undefined && options.requestHash === undefined) {
        throw new InvalidOpError("requestHash is required with idempotencyKey");
      }
      if (this.current.log.length() !== this.currentVersion) {
        await this.reloadUnlocked();
        throw new InvalidOpError("Arbor was mutated outside DurableArborSession.transact; local changes were discarded");
      }
      if (options.idempotencyKey !== undefined) {
        const previous = await this.options.store.lookupIdempotency(this.options.artifactId, options.idempotencyKey);
        if (previous) {
          if (previous.requestHash !== options.requestHash) throw new IdempotencyConflictError(options.idempotencyKey);
          if (previous.version !== this.currentVersion) await this.reloadUnlocked();
          return { value: clone(previous.result) as T, version: previous.version, replayed: true };
        }
      }

      const treeSnapshot = this.current.tree.snapshot();
      const logVersion = this.currentVersion;
      const indexSnapshot = this.current.index?.txSnapshot();
      let rolledBack = false;
      const rollback = () => {
        if (rolledBack) return;
        rolledBack = true;
        this.current.tree.restore(treeSnapshot);
        this.current.log.truncateTo(logVersion);
        if (this.current.index) this.current.index.txRestore(indexSnapshot);
      };

      try {
        const value = await mutate(this.current);
        const encoded = JSON.stringify(value);
        if (encoded === undefined) throw new InvalidOpError("Durable transaction result must be JSON-serializable");
        if (encoded.length > this.options.maxIdempotencyResultChars) {
          throw new InvalidOpError(
            `Durable transaction result is ${encoded.length} chars (cap ${this.options.maxIdempotencyResultChars})`,
          );
        }
        const persistedResult = JSON.parse(encoded) as unknown;
        const result = await this.options.store.commit({
          artifactId: this.options.artifactId,
          expectedVersion: logVersion,
          events: this.current.log.since(logVersion),
          ...(options.idempotencyKey !== undefined ? { idempotencyKey: options.idempotencyKey } : {}),
          ...(options.requestHash !== undefined ? { requestHash: options.requestHash } : {}),
          result: persistedResult,
        });
        if (result.replayed) {
          rollback();
          await this.reloadUnlocked();
          return { value: clone(result.result) as T, version: result.version, replayed: true };
        }
        this.currentVersion = result.version;
        return { value, version: result.version, replayed: false };
      } catch (error) {
        rollback();
        if (error instanceof StaleArtifactError) await this.reloadUnlocked();
        throw error;
      }
    });
  }

  async checkpoint(options: { keepLast?: number } = {}): Promise<void> {
    this.assertOpen();
    return this.enqueue(async () => {
      const checkpoint = await serializeArtifact(
        this.current.tree,
        this.current.log,
        this.current.vectors,
        { includeVectors: false, config: this.options.config },
      );
      let floor = checkpoint.baseSeq ?? 0;
      if (options.keepLast !== undefined) {
        if (!Number.isInteger(options.keepLast) || options.keepLast < 0) {
          throw new InvalidOpError("checkpoint keepLast must be a non-negative integer");
        }
        floor = Math.max(floor, this.currentVersion - options.keepLast);
        checkpoint.events = checkpoint.events.filter((event) => event.seq >= floor);
        checkpoint.baseSeq = floor;
      }
      try {
        await this.options.store.checkpoint({
          artifactId: this.options.artifactId,
          expectedVersion: this.currentVersion,
          checkpoint,
        });
        this.current.log.compactTo(floor);
      } catch (error) {
        if (error instanceof StaleArtifactError) await this.reloadUnlocked();
        throw error;
      }
    });
  }

  /** Reindex and checkpoint semantic freshness. SQL state stays authoritative if
   *  the derivative vector backend is unavailable. */
  async reindex(): Promise<void> {
    this.assertOpen();
    return this.enqueue(async () => {
      if (!this.current.index) return;
      const snapshot = this.current.tree.snapshot();
      const indexSnapshot = this.current.index.txSnapshot();
      try {
        await this.current.index.reindex();
        const checkpoint = await serializeArtifact(
          this.current.tree,
          this.current.log,
          this.current.vectors,
          { includeVectors: false, config: this.options.config },
        );
        await this.options.store.checkpoint({
          artifactId: this.options.artifactId,
          expectedVersion: this.currentVersion,
          checkpoint,
        });
      } catch (error) {
        this.current.tree.restore(snapshot);
        this.current.index.txRestore(indexSnapshot);
        if (error instanceof StaleArtifactError) await this.reloadUnlocked();
        throw error;
      }
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    await this.tail;
    this.closed = true;
    if (this.options.closeStoreOnClose) await this.options.store.close?.();
  }
}

export async function openDurableArbor(options: OpenDurableArborOptions): Promise<DurableArborSession> {
  assertArtifactId(options.artifactId);
  const normalized = {
    artifactId: options.artifactId,
    store: options.store,
    config: clone(options.config),
    arbor: options.arbor ?? {},
    vectorRecovery: options.vectorRecovery ?? "verify" as VectorRecoveryPolicy,
    maxIdempotencyResultChars: options.maxIdempotencyResultChars ?? 100_000,
    closeStoreOnClose: options.closeStoreOnClose ?? false,
  };
  if (!Number.isInteger(normalized.maxIdempotencyResultChars) || normalized.maxIdempotencyResultChars < 1) {
    throw new TypeError("maxIdempotencyResultChars must be a positive integer");
  }
  let loaded = await options.store.load(options.artifactId);
  if (!loaded) {
    if (options.createIfMissing === false) throw new InvalidOpError(`Artifact not found: ${options.artifactId}`);
    const arbor = createArbor(normalized.arbor);
    const checkpoint = await serializeArtifact(arbor.tree, arbor.log, arbor.vectors, {
      includeVectors: false,
      config: normalized.config,
    });
    const created = await options.store.create({
      artifactId: options.artifactId,
      checkpoint,
      config: normalized.config,
      configFingerprint: configFingerprint(normalized.config),
    });
    if (created) return new DurableArborSession(normalized, arbor, arbor.log.length());
    loaded = await options.store.load(options.artifactId);
  }
  if (!loaded) throw new InvalidOpError(`Artifact not found after concurrent create: ${options.artifactId}`);
  const placeholder = createArbor(normalized.arbor);
  const session = new DurableArborSession(normalized, placeholder, 0);
  await session.reload();
  return session;
}

export async function importStoredArtifact(
  store: DurableStorePort,
  artifactId: string,
  stored: StoredArtifact,
  config: ArtifactConfigIdentity,
): Promise<boolean> {
  assertArtifactId(artifactId);
  const checkpoint: StoredArtifact = {
    ...clone(stored),
    version: 3,
    config: clone(config),
  };
  delete checkpoint.vectors;
  return store.create({ artifactId, checkpoint, config, configFingerprint: configFingerprint(config) });
}

/** Utility for canonical request hashes used with idempotency keys. */
export function durableRequestHash(value: Json): string {
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}
