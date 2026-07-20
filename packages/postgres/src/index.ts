import { Pool, type PoolClient, type PoolConfig } from "pg";
import type {
  DurableCheckpointRequest,
  DurableCommitRequest,
  DurableCommitResult,
  DurableCreateRequest,
  DurableIdempotencyRecord,
  DurableLoadResult,
  DurableStorePort,
  MutationEvent,
  NodeId,
  StoredArtifact,
  VectorHit,
  VectorIndexCapabilities,
  VectorIndexEntry,
  VectorIndexMetadata,
  VectorIndexPort,
  VectorSearchFilter,
} from "arborkit";
import {
  IdempotencyConflictError,
  InvalidOpError,
  MigrationRequiredError,
  StaleArtifactError,
  VectorDimensionMismatchError,
} from "arborkit";

const SCHEMA_VERSION = 1;

function identifier(value: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) throw new TypeError(`Invalid PostgreSQL identifier: ${value}`);
  return `"${value}"`;
}

function checkpointVersion(checkpoint: StoredArtifact): number {
  return (checkpoint.baseSeq ?? 0) + checkpoint.events.length;
}

function number(value: string | number): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new InvalidOpError(`PostgreSQL bigint exceeds JavaScript safe integer: ${value}`);
  return parsed;
}

async function transaction<T>(pool: Pool, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export interface PostgresStoreOptions {
  pool?: Pool;
  connection?: PoolConfig;
  schema?: string;
}

export class PostgresDurableStore implements DurableStorePort {
  readonly pool: Pool;
  readonly schema: string;
  private readonly ownsPool: boolean;

  constructor(options: PostgresStoreOptions = {}) {
    this.pool = options.pool ?? new Pool(options.connection);
    this.ownsPool = options.pool === undefined;
    this.schema = identifier(options.schema ?? "arborkit");
  }

  async migrate(): Promise<void> {
    await transaction(this.pool, async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`arborkit:migrate:${this.schema}`]);
      await client.query(`CREATE SCHEMA IF NOT EXISTS ${this.schema}`);
      await client.query(`
        CREATE TABLE IF NOT EXISTS ${this.schema}.schema_migrations (
          version integer PRIMARY KEY,
          applied_at timestamptz NOT NULL DEFAULT now()
        )
      `);
      const current = await client.query<{ version: number | null }>(
        `SELECT MAX(version) AS version FROM ${this.schema}.schema_migrations`,
      );
      const version = current.rows[0]?.version ?? 0;
      if (version > SCHEMA_VERSION) {
        throw new MigrationRequiredError(`PostgreSQL schema ${version} is newer than supported ${SCHEMA_VERSION}`);
      }
      if (version === SCHEMA_VERSION) return;
      await client.query(`
        CREATE TABLE ${this.schema}.artifacts (
          artifact_id text PRIMARY KEY,
          current_version bigint NOT NULL,
          checkpoint_id bigint,
          config_json jsonb NOT NULL,
          config_fingerprint text NOT NULL,
          created_at timestamptz NOT NULL DEFAULT now(),
          updated_at timestamptz NOT NULL DEFAULT now()
        );
        CREATE TABLE ${this.schema}.checkpoints (
          checkpoint_id bigserial PRIMARY KEY,
          artifact_id text NOT NULL REFERENCES ${this.schema}.artifacts(artifact_id) ON DELETE CASCADE,
          version bigint NOT NULL,
          base_seq bigint NOT NULL,
          root_id text NOT NULL,
          artifact_json jsonb NOT NULL,
          created_at timestamptz NOT NULL DEFAULT now()
        );
        CREATE INDEX checkpoints_artifact_version ON ${this.schema}.checkpoints(artifact_id, version DESC);
        CREATE TABLE ${this.schema}.checkpoint_nodes (
          checkpoint_id bigint NOT NULL REFERENCES ${this.schema}.checkpoints(checkpoint_id) ON DELETE CASCADE,
          node_id text NOT NULL,
          node_json jsonb NOT NULL,
          PRIMARY KEY(checkpoint_id, node_id)
        );
        CREATE TABLE ${this.schema}.events (
          artifact_id text NOT NULL REFERENCES ${this.schema}.artifacts(artifact_id) ON DELETE CASCADE,
          seq bigint NOT NULL,
          event_json jsonb NOT NULL,
          PRIMARY KEY(artifact_id, seq)
        );
        CREATE TABLE ${this.schema}.idempotency (
          artifact_id text NOT NULL REFERENCES ${this.schema}.artifacts(artifact_id) ON DELETE CASCADE,
          key text NOT NULL,
          request_hash text NOT NULL,
          result_json jsonb NOT NULL,
          version bigint NOT NULL,
          created_at timestamptz NOT NULL DEFAULT now(),
          PRIMARY KEY(artifact_id, key)
        );
        INSERT INTO ${this.schema}.schema_migrations(version) VALUES (1);
      `);
    });
  }

  private async assertMigrated(): Promise<void> {
    try {
      const result = await this.pool.query<{ version: number | null }>(
        `SELECT MAX(version) AS version FROM ${this.schema}.schema_migrations`,
      );
      if ((result.rows[0]?.version ?? 0) !== SCHEMA_VERSION) throw new MigrationRequiredError();
    } catch (error) {
      if (error instanceof MigrationRequiredError) throw error;
      throw new MigrationRequiredError();
    }
  }

  private async insertCheckpoint(client: PoolClient, artifactId: string, checkpoint: StoredArtifact): Promise<number> {
    const inserted = await client.query<{ checkpoint_id: string }>(`
      INSERT INTO ${this.schema}.checkpoints(artifact_id, version, base_seq, root_id, artifact_json)
      VALUES ($1, $2, $3, $4, $5::jsonb) RETURNING checkpoint_id
    `, [
      artifactId,
      checkpointVersion(checkpoint),
      checkpoint.baseSeq ?? 0,
      checkpoint.rootId,
      JSON.stringify(checkpoint),
    ]);
    const checkpointId = number(inserted.rows[0]!.checkpoint_id);
    for (const node of checkpoint.nodes) {
      await client.query(`
        INSERT INTO ${this.schema}.checkpoint_nodes(checkpoint_id, node_id, node_json)
        VALUES ($1, $2, $3::jsonb)
      `, [checkpointId, node.id, JSON.stringify(node)]);
    }
    return checkpointId;
  }

  async load(artifactId: string): Promise<DurableLoadResult | null> {
    await this.assertMigrated();
    const result = await this.pool.query<{
      current_version: string;
      config_json: DurableLoadResult["config"];
      config_fingerprint: string;
      checkpoint_version: string;
      artifact_json: StoredArtifact;
    }>(`
      SELECT a.current_version, a.config_json, a.config_fingerprint,
             c.version AS checkpoint_version, c.artifact_json
      FROM ${this.schema}.artifacts a
      JOIN ${this.schema}.checkpoints c ON c.checkpoint_id = a.checkpoint_id
      WHERE a.artifact_id = $1
    `, [artifactId]);
    const row = result.rows[0];
    if (!row) return null;
    const events = await this.pool.query<{ event_json: MutationEvent }>(`
      SELECT event_json FROM ${this.schema}.events
      WHERE artifact_id = $1 AND seq >= $2 ORDER BY seq
    `, [artifactId, row.checkpoint_version]);
    return {
      artifactId,
      checkpoint: row.artifact_json,
      journal: events.rows.map((event) => event.event_json),
      currentVersion: number(row.current_version),
      config: row.config_json,
      configFingerprint: row.config_fingerprint,
    };
  }

  async create(request: DurableCreateRequest): Promise<boolean> {
    await this.assertMigrated();
    return transaction(this.pool, async (client) => {
      const inserted = await client.query(`
        INSERT INTO ${this.schema}.artifacts(
          artifact_id, current_version, checkpoint_id, config_json, config_fingerprint
        ) VALUES ($1, $2, NULL, $3::jsonb, $4)
        ON CONFLICT (artifact_id) DO NOTHING
      `, [
        request.artifactId,
        checkpointVersion(request.checkpoint),
        JSON.stringify(request.config),
        request.configFingerprint,
      ]);
      if (inserted.rowCount === 0) return false;
      const checkpointId = await this.insertCheckpoint(client, request.artifactId, request.checkpoint);
      await client.query(`UPDATE ${this.schema}.artifacts SET checkpoint_id = $1 WHERE artifact_id = $2`, [
        checkpointId,
        request.artifactId,
      ]);
      for (const event of request.checkpoint.events) {
        await client.query(`
          INSERT INTO ${this.schema}.events(artifact_id, seq, event_json) VALUES ($1, $2, $3::jsonb)
        `, [request.artifactId, event.seq, JSON.stringify(event)]);
      }
      return true;
    });
  }

  async lookupIdempotency(artifactId: string, key: string): Promise<DurableIdempotencyRecord | null> {
    await this.assertMigrated();
    const result = await this.pool.query<{ request_hash: string; result_json: unknown; version: string }>(`
      SELECT request_hash, result_json, version FROM ${this.schema}.idempotency
      WHERE artifact_id = $1 AND key = $2
    `, [artifactId, key]);
    const row = result.rows[0];
    return row ? { requestHash: row.request_hash, result: row.result_json, version: number(row.version) } : null;
  }

  async commit(request: DurableCommitRequest): Promise<DurableCommitResult> {
    await this.assertMigrated();
    return transaction(this.pool, async (client) => {
      if (request.idempotencyKey !== undefined) {
        if (request.requestHash === undefined) throw new InvalidOpError("requestHash is required with idempotencyKey");
        const existing = await client.query<{ request_hash: string; result_json: unknown; version: string }>(`
          SELECT request_hash, result_json, version FROM ${this.schema}.idempotency
          WHERE artifact_id = $1 AND key = $2
        `, [request.artifactId, request.idempotencyKey]);
        const row = existing.rows[0];
        if (row) {
          if (row.request_hash !== request.requestHash) throw new IdempotencyConflictError(request.idempotencyKey);
          return { version: number(row.version), replayed: true, result: row.result_json };
        }
      }
      const version = request.expectedVersion + request.events.length;
      const updated = await client.query(`
        UPDATE ${this.schema}.artifacts SET current_version = $1, updated_at = now()
        WHERE artifact_id = $2 AND current_version = $3
      `, [version, request.artifactId, request.expectedVersion]);
      if (updated.rowCount !== 1) {
        const actual = await client.query<{ current_version: string }>(
          `SELECT current_version FROM ${this.schema}.artifacts WHERE artifact_id = $1`,
          [request.artifactId],
        );
        if (!actual.rows[0]) throw new InvalidOpError(`Artifact not found: ${request.artifactId}`);
        throw new StaleArtifactError(request.artifactId, request.expectedVersion, number(actual.rows[0].current_version));
      }
      for (const [index, event] of request.events.entries()) {
        const expected = request.expectedVersion + index;
        if (event.seq !== expected) throw new InvalidOpError(`Expected event seq ${expected}, got ${event.seq}`);
        await client.query(`
          INSERT INTO ${this.schema}.events(artifact_id, seq, event_json) VALUES ($1, $2, $3::jsonb)
        `, [request.artifactId, event.seq, JSON.stringify(event)]);
      }
      if (request.idempotencyKey !== undefined) {
        await client.query(`
          INSERT INTO ${this.schema}.idempotency(artifact_id, key, request_hash, result_json, version)
          VALUES ($1, $2, $3, $4::jsonb, $5)
        `, [
          request.artifactId,
          request.idempotencyKey,
          request.requestHash,
          JSON.stringify(request.result),
          version,
        ]);
      }
      return { version, replayed: false, result: request.result };
    });
  }

  async checkpoint(request: DurableCheckpointRequest): Promise<void> {
    await this.assertMigrated();
    await transaction(this.pool, async (client) => {
      const artifact = await client.query<{ current_version: string }>(`
        SELECT current_version FROM ${this.schema}.artifacts WHERE artifact_id = $1 FOR UPDATE
      `, [request.artifactId]);
      if (!artifact.rows[0]) throw new InvalidOpError(`Artifact not found: ${request.artifactId}`);
      const actual = number(artifact.rows[0].current_version);
      if (actual !== request.expectedVersion) {
        throw new StaleArtifactError(request.artifactId, request.expectedVersion, actual);
      }
      if (checkpointVersion(request.checkpoint) !== request.expectedVersion) {
        throw new InvalidOpError("Checkpoint version does not match expectedVersion");
      }
      const checkpointId = await this.insertCheckpoint(client, request.artifactId, request.checkpoint);
      await client.query(`
        UPDATE ${this.schema}.artifacts SET checkpoint_id = $1, updated_at = now() WHERE artifact_id = $2
      `, [checkpointId, request.artifactId]);
      await client.query(`DELETE FROM ${this.schema}.events WHERE artifact_id = $1 AND seq < $2`, [
        request.artifactId,
        request.checkpoint.baseSeq ?? 0,
      ]);
      await client.query(`
        DELETE FROM ${this.schema}.checkpoints
        WHERE artifact_id = $1 AND checkpoint_id NOT IN (
          SELECT checkpoint_id FROM ${this.schema}.checkpoints
          WHERE artifact_id = $1 ORDER BY version DESC, checkpoint_id DESC LIMIT 2
        )
      `, [request.artifactId]);
    });
  }

  async close(): Promise<void> {
    if (this.ownsPool) await this.pool.end();
  }
}

export interface PgVectorIndexOptions {
  pool: Pool;
  artifactId: string;
  dimensions: number;
  schema?: string;
  namespace?: string;
}

function vectorLiteral(vector: number[]): string {
  return `[${vector.join(",")}]`;
}

function parseVector(value: string | number[]): number[] {
  if (Array.isArray(value)) return value.map(Number);
  return value.slice(1, -1).split(",").filter(Boolean).map(Number);
}

export class PgVectorIndex implements VectorIndexPort {
  readonly capabilities: VectorIndexCapabilities = {
    persistent: true,
    filters: ["under", "type", "tag"],
    metadata: true,
  };
  private readonly schema: string;
  private readonly table: string;
  private readonly indexName: string;

  constructor(private readonly options: PgVectorIndexOptions) {
    if (!Number.isInteger(options.dimensions) || options.dimensions < 1) throw new TypeError("dimensions must be positive");
    this.schema = identifier(options.schema ?? "arborkit");
    this.table = identifier(`${options.namespace ?? "arborkit"}_vectors`);
    this.indexName = identifier(`${options.namespace ?? "arborkit"}_vectors_hnsw`);
  }

  async initialize(options: { installExtension?: boolean } = {}): Promise<void> {
    await transaction(this.options.pool, async (client) => {
      if (options.installExtension) await client.query("CREATE EXTENSION IF NOT EXISTS vector");
      const extension = await client.query("SELECT 1 FROM pg_extension WHERE extname = 'vector'");
      if (extension.rowCount !== 1) throw new MigrationRequiredError("pgvector extension is not installed");
      await client.query(`CREATE SCHEMA IF NOT EXISTS ${this.schema}`);
      await client.query(`
        CREATE TABLE IF NOT EXISTS ${this.schema}.${this.table} (
          artifact_id text NOT NULL,
          node_id text NOT NULL,
          embedding vector(${this.options.dimensions}) NOT NULL,
          path text,
          scope_paths text[] NOT NULL DEFAULT '{}',
          node_type text,
          tags text[] NOT NULL DEFAULT '{}',
          text_hash text,
          PRIMARY KEY(artifact_id, node_id)
        )
      `);
      await client.query(`
        CREATE INDEX IF NOT EXISTS ${this.indexName}
        ON ${this.schema}.${this.table} USING hnsw (embedding vector_cosine_ops)
      `);
      await client.query(`CREATE INDEX IF NOT EXISTS ${identifier(`${this.options.namespace ?? "arborkit"}_vectors_artifact`)} ON ${this.schema}.${this.table}(artifact_id)`);
      await client.query(`CREATE INDEX IF NOT EXISTS ${identifier(`${this.options.namespace ?? "arborkit"}_vectors_scopes`)} ON ${this.schema}.${this.table} USING gin(scope_paths)`);
      await client.query(`CREATE INDEX IF NOT EXISTS ${identifier(`${this.options.namespace ?? "arborkit"}_vectors_tags`)} ON ${this.schema}.${this.table} USING gin(tags)`);
    });
  }

  async upsert(entries: VectorIndexEntry[]): Promise<void> {
    await transaction(this.options.pool, async (client) => {
      for (const entry of entries) {
        if (entry.vector.length !== this.options.dimensions) {
          throw new VectorDimensionMismatchError(this.options.dimensions, entry.vector.length);
        }
        const meta = entry.metadata;
        await client.query(`
          INSERT INTO ${this.schema}.${this.table}(
            artifact_id, node_id, embedding, path, scope_paths, node_type, tags, text_hash
          ) VALUES ($1, $2, $3::vector, $4, $5, $6, $7, $8)
          ON CONFLICT (artifact_id, node_id) DO UPDATE SET
            embedding = EXCLUDED.embedding, path = EXCLUDED.path, scope_paths = EXCLUDED.scope_paths,
            node_type = EXCLUDED.node_type, tags = EXCLUDED.tags, text_hash = EXCLUDED.text_hash
        `, [
          this.options.artifactId,
          entry.nodeId,
          vectorLiteral(entry.vector),
          meta?.path ?? null,
          meta?.scopePaths ?? [],
          meta?.type ?? null,
          meta?.tags ?? [],
          meta?.textHash ?? null,
        ]);
      }
    });
  }

  async remove(nodeId: NodeId): Promise<void> {
    await this.options.pool.query(
      `DELETE FROM ${this.schema}.${this.table} WHERE artifact_id = $1 AND node_id = $2`,
      [this.options.artifactId, nodeId],
    );
  }

  async search(query: number[], k: number, filter: VectorSearchFilter = {}): Promise<VectorHit[]> {
    if (query.length !== this.options.dimensions) {
      throw new VectorDimensionMismatchError(this.options.dimensions, query.length);
    }
    const values: unknown[] = [this.options.artifactId, vectorLiteral(query)];
    const clauses = ["artifact_id = $1"];
    if (filter.under !== undefined) {
      values.push(filter.under);
      clauses.push(`$${values.length} = ANY(scope_paths)`);
    }
    if (filter.type !== undefined) {
      values.push(filter.type);
      clauses.push(`node_type = $${values.length}`);
    }
    if (filter.tag !== undefined) {
      values.push(filter.tag);
      clauses.push(`$${values.length} = ANY(tags)`);
    }
    values.push(k);
    const result = await this.options.pool.query<{ node_id: string; score: number }>(`
      SELECT node_id, 1 - (embedding <=> $2::vector) AS score
      FROM ${this.schema}.${this.table}
      WHERE ${clauses.join(" AND ")}
      ORDER BY embedding <=> $2::vector
      LIMIT $${values.length}
    `, values);
    return result.rows.map((row) => ({ nodeId: row.node_id, score: Number(row.score) }));
  }

  async has(nodeId: NodeId): Promise<boolean> {
    const result = await this.options.pool.query(
      `SELECT 1 FROM ${this.schema}.${this.table} WHERE artifact_id = $1 AND node_id = $2`,
      [this.options.artifactId, nodeId],
    );
    return result.rowCount === 1;
  }

  async size(): Promise<number> {
    const result = await this.options.pool.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM ${this.schema}.${this.table} WHERE artifact_id = $1`,
      [this.options.artifactId],
    );
    return number(result.rows[0]!.count);
  }

  async entries(): Promise<VectorIndexEntry[]> {
    const result = await this.options.pool.query<{
      node_id: string;
      embedding: string | number[];
      path: string | null;
      scope_paths: string[];
      node_type: string | null;
      tags: string[];
      text_hash: string | null;
    }>(`
      SELECT node_id, embedding, path, scope_paths, node_type, tags, text_hash
      FROM ${this.schema}.${this.table} WHERE artifact_id = $1 ORDER BY node_id
    `, [this.options.artifactId]);
    return result.rows.map((row) => ({
      nodeId: row.node_id,
      vector: parseVector(row.embedding),
      metadata: {
        ...(row.path !== null ? { path: row.path } : {}),
        scopePaths: row.scope_paths,
        ...(row.node_type !== null ? { type: row.node_type } : {}),
        tags: row.tags,
        ...(row.text_hash !== null ? { textHash: row.text_hash } : {}),
      },
    }));
  }

  async metadata(nodeIds: readonly NodeId[]): Promise<Map<NodeId, VectorIndexMetadata>> {
    if (nodeIds.length === 0) return new Map();
    const result = await this.options.pool.query<{
      node_id: string;
      path: string | null;
      scope_paths: string[];
      node_type: string | null;
      tags: string[];
      text_hash: string | null;
    }>(`
      SELECT node_id, path, scope_paths, node_type, tags, text_hash
      FROM ${this.schema}.${this.table}
      WHERE artifact_id = $1 AND node_id = ANY($2::text[])
    `, [this.options.artifactId, [...nodeIds]]);
    return new Map(result.rows.map((row) => [row.node_id, {
      ...(row.path !== null ? { path: row.path } : {}),
      scopePaths: row.scope_paths,
      ...(row.node_type !== null ? { type: row.node_type } : {}),
      tags: row.tags,
      ...(row.text_hash !== null ? { textHash: row.text_hash } : {}),
    }]));
  }
}
