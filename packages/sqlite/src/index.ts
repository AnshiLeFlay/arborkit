import Database from "better-sqlite3";
import type {
  DurableCheckpointRequest,
  DurableCommitRequest,
  DurableCommitResult,
  DurableCreateRequest,
  DurableIdempotencyRecord,
  DurableLoadResult,
  DurableStorePort,
  MutationEvent,
  StoredArtifact,
} from "arborkit";
import {
  IdempotencyConflictError,
  InvalidOpError,
  MigrationRequiredError,
  StaleArtifactError,
} from "arborkit";

const SCHEMA_VERSION = 1;

export interface SqliteStoreOptions {
  filename: string;
  busyTimeoutMs?: number;
  wal?: boolean;
  readonly?: boolean;
}

function checkpointVersion(checkpoint: StoredArtifact): number {
  return (checkpoint.baseSeq ?? 0) + checkpoint.events.length;
}

function parse<T>(value: string): T {
  return JSON.parse(value) as T;
}

export function migrateSqlite(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS arborkit_schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at INTEGER NOT NULL
    );
  `);
  const current = db.prepare("SELECT MAX(version) AS version FROM arborkit_schema_migrations").get() as
    | { version: number | null }
    | undefined;
  if ((current?.version ?? 0) > SCHEMA_VERSION) {
    throw new MigrationRequiredError(`SQLite schema ${current!.version} is newer than supported ${SCHEMA_VERSION}`);
  }
  if ((current?.version ?? 0) === SCHEMA_VERSION) return;
  db.transaction(() => {
    db.exec(`
      CREATE TABLE arborkit_artifacts (
        artifact_id TEXT PRIMARY KEY,
        current_version INTEGER NOT NULL,
        checkpoint_id INTEGER,
        config_json TEXT NOT NULL,
        config_fingerprint TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE arborkit_checkpoints (
        checkpoint_id INTEGER PRIMARY KEY AUTOINCREMENT,
        artifact_id TEXT NOT NULL REFERENCES arborkit_artifacts(artifact_id) ON DELETE CASCADE,
        version INTEGER NOT NULL,
        base_seq INTEGER NOT NULL,
        root_id TEXT NOT NULL,
        artifact_json TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX arborkit_checkpoints_artifact_version
        ON arborkit_checkpoints(artifact_id, version DESC);
      CREATE TABLE arborkit_checkpoint_nodes (
        checkpoint_id INTEGER NOT NULL REFERENCES arborkit_checkpoints(checkpoint_id) ON DELETE CASCADE,
        node_id TEXT NOT NULL,
        node_json TEXT NOT NULL,
        PRIMARY KEY(checkpoint_id, node_id)
      );
      CREATE TABLE arborkit_events (
        artifact_id TEXT NOT NULL REFERENCES arborkit_artifacts(artifact_id) ON DELETE CASCADE,
        seq INTEGER NOT NULL,
        event_json TEXT NOT NULL,
        PRIMARY KEY(artifact_id, seq)
      );
      CREATE TABLE arborkit_idempotency (
        artifact_id TEXT NOT NULL REFERENCES arborkit_artifacts(artifact_id) ON DELETE CASCADE,
        key TEXT NOT NULL,
        request_hash TEXT NOT NULL,
        result_json TEXT NOT NULL,
        version INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY(artifact_id, key)
      );
      INSERT INTO arborkit_schema_migrations(version, applied_at)
        VALUES (1, CAST(strftime('%s','now') AS INTEGER) * 1000);
    `);
  })();
}

export class SqliteDurableStore implements DurableStorePort {
  readonly db: Database.Database;
  private closed = false;

  constructor(options: SqliteStoreOptions | Database.Database) {
    if (typeof options === "object" && "prepare" in options) {
      this.db = options;
    } else {
      const databaseOptions: Database.Options = { timeout: options.busyTimeoutMs ?? 5_000 };
      if (options.readonly !== undefined) databaseOptions.readonly = options.readonly;
      this.db = new Database(options.filename, databaseOptions);
      this.db.pragma("foreign_keys = ON");
      this.db.pragma(`busy_timeout = ${options.busyTimeoutMs ?? 5_000}`);
      if (options.wal !== false && !options.readonly) this.db.pragma("journal_mode = WAL");
    }
  }

  migrate(): void {
    migrateSqlite(this.db);
  }

  private assertMigrated(): void {
    try {
      const row = this.db.prepare("SELECT MAX(version) AS version FROM arborkit_schema_migrations").get() as
        | { version: number | null }
        | undefined;
      if ((row?.version ?? 0) !== SCHEMA_VERSION) throw new MigrationRequiredError();
    } catch (error) {
      if (error instanceof MigrationRequiredError) throw error;
      throw new MigrationRequiredError();
    }
  }

  async load(artifactId: string): Promise<DurableLoadResult | null> {
    this.assertMigrated();
    const row = this.db.prepare(`
      SELECT a.current_version, a.config_json, a.config_fingerprint, c.version AS checkpoint_version,
             c.artifact_json
      FROM arborkit_artifacts a
      JOIN arborkit_checkpoints c ON c.checkpoint_id = a.checkpoint_id
      WHERE a.artifact_id = ?
    `).get(artifactId) as {
      current_version: number;
      config_json: string;
      config_fingerprint: string;
      checkpoint_version: number;
      artifact_json: string;
    } | undefined;
    if (!row) return null;
    const events = this.db.prepare(`
      SELECT event_json FROM arborkit_events
      WHERE artifact_id = ? AND seq >= ? ORDER BY seq
    `).all(artifactId, row.checkpoint_version) as Array<{ event_json: string }>;
    return {
      artifactId,
      checkpoint: parse(row.artifact_json),
      journal: events.map((event) => parse<MutationEvent>(event.event_json)),
      currentVersion: row.current_version,
      config: parse(row.config_json),
      configFingerprint: row.config_fingerprint,
    };
  }

  async create(request: DurableCreateRequest): Promise<boolean> {
    this.assertMigrated();
    return this.db.transaction(() => {
      const now = Date.now();
      const inserted = this.db.prepare(`
        INSERT OR IGNORE INTO arborkit_artifacts(
          artifact_id, current_version, checkpoint_id, config_json, config_fingerprint, created_at, updated_at
        ) VALUES (?, ?, NULL, ?, ?, ?, ?)
      `).run(
        request.artifactId,
        checkpointVersion(request.checkpoint),
        JSON.stringify(request.config),
        request.configFingerprint,
        now,
        now,
      );
      if (inserted.changes === 0) return false;
      const checkpointId = this.insertCheckpoint(request.artifactId, request.checkpoint, now);
      this.db.prepare("UPDATE arborkit_artifacts SET checkpoint_id = ? WHERE artifact_id = ?")
        .run(checkpointId, request.artifactId);
      const insertEvent = this.db.prepare(
        "INSERT INTO arborkit_events(artifact_id, seq, event_json) VALUES (?, ?, ?)",
      );
      for (const event of request.checkpoint.events) {
        insertEvent.run(request.artifactId, event.seq, JSON.stringify(event));
      }
      return true;
    })();
  }

  private insertCheckpoint(artifactId: string, checkpoint: StoredArtifact, now = Date.now()): number {
    const result = this.db.prepare(`
      INSERT INTO arborkit_checkpoints(artifact_id, version, base_seq, root_id, artifact_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      artifactId,
      checkpointVersion(checkpoint),
      checkpoint.baseSeq ?? 0,
      checkpoint.rootId,
      JSON.stringify(checkpoint),
      now,
    );
    const checkpointId = Number(result.lastInsertRowid);
    const insertNode = this.db.prepare(
      "INSERT INTO arborkit_checkpoint_nodes(checkpoint_id, node_id, node_json) VALUES (?, ?, ?)",
    );
    for (const node of checkpoint.nodes) insertNode.run(checkpointId, node.id, JSON.stringify(node));
    return checkpointId;
  }

  async lookupIdempotency(artifactId: string, key: string): Promise<DurableIdempotencyRecord | null> {
    this.assertMigrated();
    const row = this.db.prepare(`
      SELECT request_hash, result_json, version FROM arborkit_idempotency
      WHERE artifact_id = ? AND key = ?
    `).get(artifactId, key) as { request_hash: string; result_json: string; version: number } | undefined;
    return row ? { requestHash: row.request_hash, result: parse(row.result_json), version: row.version } : null;
  }

  async commit(request: DurableCommitRequest): Promise<DurableCommitResult> {
    this.assertMigrated();
    return this.db.transaction(() => {
      if (request.idempotencyKey !== undefined) {
        if (request.requestHash === undefined) throw new InvalidOpError("requestHash is required with idempotencyKey");
        const existing = this.db.prepare(`
          SELECT request_hash, result_json, version FROM arborkit_idempotency
          WHERE artifact_id = ? AND key = ?
        `).get(request.artifactId, request.idempotencyKey) as
          | { request_hash: string; result_json: string; version: number }
          | undefined;
        if (existing) {
          if (existing.request_hash !== request.requestHash) throw new IdempotencyConflictError(request.idempotencyKey);
          return { version: existing.version, replayed: true, result: parse(existing.result_json) };
        }
      }
      const version = request.expectedVersion + request.events.length;
      const updated = this.db.prepare(`
        UPDATE arborkit_artifacts SET current_version = ?, updated_at = ?
        WHERE artifact_id = ? AND current_version = ?
      `).run(version, Date.now(), request.artifactId, request.expectedVersion);
      if (updated.changes !== 1) {
        const row = this.db.prepare("SELECT current_version FROM arborkit_artifacts WHERE artifact_id = ?")
          .get(request.artifactId) as { current_version: number } | undefined;
        if (!row) throw new InvalidOpError(`Artifact not found: ${request.artifactId}`);
        throw new StaleArtifactError(request.artifactId, request.expectedVersion, row.current_version);
      }
      const insert = this.db.prepare(
        "INSERT INTO arborkit_events(artifact_id, seq, event_json) VALUES (?, ?, ?)",
      );
      for (const [index, event] of request.events.entries()) {
        const expected = request.expectedVersion + index;
        if (event.seq !== expected) throw new InvalidOpError(`Expected event seq ${expected}, got ${event.seq}`);
        insert.run(request.artifactId, event.seq, JSON.stringify(event));
      }
      if (request.idempotencyKey !== undefined) {
        this.db.prepare(`
          INSERT INTO arborkit_idempotency(artifact_id, key, request_hash, result_json, version, created_at)
          VALUES (?, ?, ?, ?, ?, ?)
        `).run(
          request.artifactId,
          request.idempotencyKey,
          request.requestHash,
          JSON.stringify(request.result),
          version,
          Date.now(),
        );
      }
      return { version, replayed: false, result: request.result };
    })();
  }

  async checkpoint(request: DurableCheckpointRequest): Promise<void> {
    this.assertMigrated();
    this.db.transaction(() => {
      const row = this.db.prepare("SELECT current_version FROM arborkit_artifacts WHERE artifact_id = ?")
        .get(request.artifactId) as { current_version: number } | undefined;
      if (!row) throw new InvalidOpError(`Artifact not found: ${request.artifactId}`);
      if (row.current_version !== request.expectedVersion) {
        throw new StaleArtifactError(request.artifactId, request.expectedVersion, row.current_version);
      }
      if (checkpointVersion(request.checkpoint) !== request.expectedVersion) {
        throw new InvalidOpError("Checkpoint version does not match expectedVersion");
      }
      const checkpointId = this.insertCheckpoint(request.artifactId, request.checkpoint);
      this.db.prepare("UPDATE arborkit_artifacts SET checkpoint_id = ?, updated_at = ? WHERE artifact_id = ?")
        .run(checkpointId, Date.now(), request.artifactId);
      this.db.prepare("DELETE FROM arborkit_events WHERE artifact_id = ? AND seq < ?")
        .run(request.artifactId, request.checkpoint.baseSeq ?? 0);
      this.db.prepare(`
        DELETE FROM arborkit_checkpoints
        WHERE artifact_id = ? AND checkpoint_id NOT IN (
          SELECT checkpoint_id FROM arborkit_checkpoints
          WHERE artifact_id = ? ORDER BY version DESC, checkpoint_id DESC LIMIT 2
        )
      `).run(request.artifactId, request.artifactId);
    })();
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }
}
