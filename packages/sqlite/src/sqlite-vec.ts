import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import type {
  NodeId,
  VectorHit,
  VectorIndexCapabilities,
  VectorIndexEntry,
  VectorIndexMetadata,
  VectorIndexPort,
  VectorSearchFilter,
} from "arborkit";
import { VectorDimensionMismatchError } from "arborkit";

export interface SqliteVecIndexOptions {
  db: Database.Database;
  artifactId: string;
  dimensions: number;
  namespace?: string;
}

function safeNamespace(value: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) throw new TypeError("sqlite-vec namespace must be a SQL identifier");
  return value;
}

function matches(metadata: VectorIndexMetadata | undefined, filter: VectorSearchFilter | undefined): boolean {
  if (!filter) return true;
  if (filter.under !== undefined && !(metadata?.scopePaths?.includes(filter.under) ?? false)) return false;
  if (filter.type !== undefined && metadata?.type !== filter.type) return false;
  if (filter.tag !== undefined && !(metadata?.tags?.includes(filter.tag) ?? false)) return false;
  return true;
}

/** sqlite-vec-backed local index. Metadata lives in a companion table so the
 *  public filtering contract stays identical to pgvector and Qdrant. */
export class SqliteVecIndex implements VectorIndexPort {
  readonly capabilities: VectorIndexCapabilities = {
    persistent: true,
    filters: ["under", "type", "tag"],
    metadata: true,
  };
  private readonly mapTable: string;
  private readonly vecTable: string;

  constructor(private readonly options: SqliteVecIndexOptions) {
    if (!Number.isInteger(options.dimensions) || options.dimensions < 1) throw new TypeError("dimensions must be positive");
    const namespace = safeNamespace(options.namespace ?? "arborkit");
    this.mapTable = `${namespace}_vector_map`;
    this.vecTable = `${namespace}_vectors`;
  }

  initialize(): void {
    sqliteVec.load(this.options.db);
    this.options.db.exec(`
      CREATE TABLE IF NOT EXISTS ${this.mapTable} (
        rowid INTEGER PRIMARY KEY AUTOINCREMENT,
        artifact_id TEXT NOT NULL,
        node_id TEXT NOT NULL,
        metadata_json TEXT NOT NULL,
        vector_json TEXT NOT NULL,
        UNIQUE(artifact_id, node_id)
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS ${this.vecTable} USING vec0(
        embedding float[${this.options.dimensions}]
      );
    `);
  }

  async upsert(entries: VectorIndexEntry[]): Promise<void> {
    this.options.db.transaction(() => {
      for (const entry of entries) {
        if (entry.vector.length !== this.options.dimensions) {
          throw new VectorDimensionMismatchError(this.options.dimensions, entry.vector.length);
        }
        const previous = this.options.db.prepare(
          `SELECT rowid FROM ${this.mapTable} WHERE artifact_id = ? AND node_id = ?`,
        ).get(this.options.artifactId, entry.nodeId) as { rowid: number } | undefined;
        let rowid = previous?.rowid;
        if (rowid === undefined) {
          const inserted = this.options.db.prepare(`
            INSERT INTO ${this.mapTable}(artifact_id, node_id, metadata_json, vector_json)
            VALUES (?, ?, ?, ?)
          `).run(this.options.artifactId, entry.nodeId, JSON.stringify(entry.metadata ?? {}), JSON.stringify(entry.vector));
          rowid = Number(inserted.lastInsertRowid);
        } else {
          this.options.db.prepare(`
            UPDATE ${this.mapTable} SET metadata_json = ?, vector_json = ? WHERE rowid = ?
          `).run(JSON.stringify(entry.metadata ?? {}), JSON.stringify(entry.vector), rowid);
          this.options.db.prepare(`DELETE FROM ${this.vecTable} WHERE rowid = ?`).run(rowid);
        }
        this.options.db.prepare(`INSERT INTO ${this.vecTable}(rowid, embedding) VALUES (?, ?)`)
          .run(BigInt(rowid), new Float32Array(entry.vector));
      }
    })();
  }

  async remove(nodeId: NodeId): Promise<void> {
    this.options.db.transaction(() => {
      const row = this.options.db.prepare(
        `SELECT rowid FROM ${this.mapTable} WHERE artifact_id = ? AND node_id = ?`,
      ).get(this.options.artifactId, nodeId) as { rowid: number } | undefined;
      if (!row) return;
      this.options.db.prepare(`DELETE FROM ${this.vecTable} WHERE rowid = ?`).run(row.rowid);
      this.options.db.prepare(`DELETE FROM ${this.mapTable} WHERE rowid = ?`).run(row.rowid);
    })();
  }

  async search(query: number[], k: number, filter?: VectorSearchFilter): Promise<VectorHit[]> {
    if (query.length !== this.options.dimensions) {
      throw new VectorDimensionMismatchError(this.options.dimensions, query.length);
    }
    const total = await this.size();
    if (total === 0 || k <= 0) return [];
    const rows = this.options.db.prepare(`
      SELECT m.node_id, m.metadata_json, v.distance
      FROM ${this.vecTable} v JOIN ${this.mapTable} m ON m.rowid = v.rowid
      WHERE v.embedding MATCH ? AND k = ? AND m.artifact_id = ?
      ORDER BY v.distance
    `).all(new Float32Array(query), total, this.options.artifactId) as Array<{
      node_id: string;
      metadata_json: string;
      distance: number;
    }>;
    return rows
      .filter((row) => matches(JSON.parse(row.metadata_json) as VectorIndexMetadata, filter))
      .slice(0, k)
      .map((row) => ({ nodeId: row.node_id, score: 1 - row.distance }));
  }

  async has(nodeId: NodeId): Promise<boolean> {
    return this.options.db.prepare(
      `SELECT 1 FROM ${this.mapTable} WHERE artifact_id = ? AND node_id = ?`,
    ).get(this.options.artifactId, nodeId) !== undefined;
  }

  async size(): Promise<number> {
    const row = this.options.db.prepare(
      `SELECT COUNT(*) AS count FROM ${this.mapTable} WHERE artifact_id = ?`,
    ).get(this.options.artifactId) as { count: number };
    return row.count;
  }

  async entries(): Promise<VectorIndexEntry[]> {
    const rows = this.options.db.prepare(`
      SELECT node_id, vector_json, metadata_json FROM ${this.mapTable} WHERE artifact_id = ? ORDER BY node_id
    `).all(this.options.artifactId) as Array<{ node_id: string; vector_json: string; metadata_json: string }>;
    return rows.map((row) => ({
      nodeId: row.node_id,
      vector: JSON.parse(row.vector_json) as number[],
      metadata: JSON.parse(row.metadata_json) as VectorIndexMetadata,
    }));
  }

  async metadata(nodeIds: readonly NodeId[]): Promise<Map<NodeId, VectorIndexMetadata>> {
    const result = new Map<NodeId, VectorIndexMetadata>();
    const get = this.options.db.prepare(`
      SELECT metadata_json FROM ${this.mapTable} WHERE artifact_id = ? AND node_id = ?
    `);
    for (const nodeId of nodeIds) {
      const row = get.get(this.options.artifactId, nodeId) as { metadata_json: string } | undefined;
      if (row) result.set(nodeId, JSON.parse(row.metadata_json) as VectorIndexMetadata);
    }
    return result;
  }
}
