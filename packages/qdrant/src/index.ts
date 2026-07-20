import { createHash } from "node:crypto";
import { QdrantClient } from "@qdrant/js-client-rest";
import type {
  NodeId,
  VectorHit,
  VectorIndexCapabilities,
  VectorIndexEntry,
  VectorIndexMetadata,
  VectorIndexPort,
  VectorSearchFilter,
} from "arborkit";
import { MigrationRequiredError, VectorDimensionMismatchError } from "arborkit";

export interface QdrantVectorIndexOptions {
  artifactId: string;
  dimensions: number;
  collection?: string;
  client?: QdrantClient;
  url?: string;
  apiKey?: string;
}

interface ArborPayload {
  artifactId: string;
  nodeId: string;
  path?: string;
  scopePaths: string[];
  type?: string;
  tags: string[];
  textHash?: string;
}

export function qdrantPointId(artifactId: string, nodeId: string): string {
  const hex = createHash("sha256").update(`${artifactId}\0${nodeId}`).digest("hex").slice(0, 32).split("");
  hex[12] = "5";
  hex[16] = ((Number.parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16);
  const value = hex.join("");
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}

function isNotFound(error: unknown): boolean {
  const status = (error as { status?: number; response?: { status?: number } })?.status ??
    (error as { response?: { status?: number } })?.response?.status;
  return status === 404;
}

function metadataFromPayload(payload: Partial<ArborPayload>): VectorIndexMetadata {
  return {
    ...(payload.path !== undefined ? { path: payload.path } : {}),
    scopePaths: payload.scopePaths ?? [],
    ...(payload.type !== undefined ? { type: payload.type } : {}),
    tags: payload.tags ?? [],
    ...(payload.textHash !== undefined ? { textHash: payload.textHash } : {}),
  };
}

export class QdrantVectorIndex implements VectorIndexPort {
  readonly capabilities: VectorIndexCapabilities = {
    persistent: true,
    filters: ["under", "type", "tag"],
    metadata: true,
  };
  readonly client: QdrantClient;
  readonly collection: string;

  constructor(private readonly options: QdrantVectorIndexOptions) {
    if (!Number.isInteger(options.dimensions) || options.dimensions < 1) throw new TypeError("dimensions must be positive");
    this.collection = options.collection ?? "arborkit";
    if (!/^[A-Za-z0-9_-]+$/.test(this.collection)) throw new TypeError("Invalid Qdrant collection name");
    this.client = options.client ?? new QdrantClient({
      url: options.url ?? "http://127.0.0.1:6333",
      ...(options.apiKey !== undefined ? { apiKey: options.apiKey } : {}),
    });
  }

  async ensureCollection(options: { createIfMissing?: boolean } = {}): Promise<void> {
    let info: unknown;
    try {
      info = await this.client.getCollection(this.collection);
    } catch (error) {
      if (!isNotFound(error) || options.createIfMissing === false) throw error;
      await this.client.createCollection(this.collection, {
        vectors: { size: this.options.dimensions, distance: "Cosine" },
      });
      info = await this.client.getCollection(this.collection);
    }
    const vectors = (info as {
      config?: { params?: { vectors?: { size?: number; distance?: string } } };
    }).config?.params?.vectors;
    if (!vectors || Array.isArray(vectors) || vectors.size === undefined) {
      throw new MigrationRequiredError("Qdrant collection must use one unnamed dense vector");
    }
    if (vectors.size !== this.options.dimensions) {
      throw new VectorDimensionMismatchError(this.options.dimensions, vectors.size);
    }
    if (vectors.distance !== "Cosine") throw new MigrationRequiredError("Qdrant collection must use Cosine distance");
    for (const field of ["artifactId", "scopePaths", "type", "tags"] as const) {
      await this.client.createPayloadIndex(this.collection, {
        field_name: field,
        field_schema: "keyword",
        wait: true,
      }).catch((error: unknown) => {
        const status = (error as { status?: number })?.status;
        if (status !== 409) throw error;
      });
    }
  }

  private artifactFilter() {
    return { key: "artifactId", match: { value: this.options.artifactId } } as const;
  }

  async upsert(entries: VectorIndexEntry[]): Promise<void> {
    if (entries.length === 0) return;
    for (const entry of entries) {
      if (entry.vector.length !== this.options.dimensions) {
        throw new VectorDimensionMismatchError(this.options.dimensions, entry.vector.length);
      }
    }
    await this.client.upsert(this.collection, {
      wait: true,
      points: entries.map((entry) => ({
        id: qdrantPointId(this.options.artifactId, entry.nodeId),
        vector: entry.vector,
        payload: {
          artifactId: this.options.artifactId,
          nodeId: entry.nodeId,
          ...(entry.metadata?.path !== undefined ? { path: entry.metadata.path } : {}),
          scopePaths: entry.metadata?.scopePaths ?? [],
          ...(entry.metadata?.type !== undefined ? { type: entry.metadata.type } : {}),
          tags: entry.metadata?.tags ?? [],
          ...(entry.metadata?.textHash !== undefined ? { textHash: entry.metadata.textHash } : {}),
        },
      })),
    });
  }

  async remove(nodeId: NodeId): Promise<void> {
    await this.client.delete(this.collection, {
      wait: true,
      points: [qdrantPointId(this.options.artifactId, nodeId)],
    });
  }

  async search(query: number[], k: number, filter: VectorSearchFilter = {}): Promise<VectorHit[]> {
    if (query.length !== this.options.dimensions) {
      throw new VectorDimensionMismatchError(this.options.dimensions, query.length);
    }
    const must: Array<Record<string, unknown>> = [this.artifactFilter()];
    if (filter.under !== undefined) must.push({ key: "scopePaths", match: { value: filter.under } });
    if (filter.type !== undefined) must.push({ key: "type", match: { value: filter.type } });
    if (filter.tag !== undefined) must.push({ key: "tags", match: { value: filter.tag } });
    const points = await this.client.search(this.collection, {
      vector: query,
      limit: k,
      filter: { must },
      with_payload: true,
      with_vector: false,
    });
    return points.flatMap((point) => {
      const payload = point.payload as Partial<ArborPayload> | null | undefined;
      return typeof payload?.nodeId === "string" ? [{ nodeId: payload.nodeId, score: point.score }] : [];
    });
  }

  async has(nodeId: NodeId): Promise<boolean> {
    const points = await this.client.retrieve(this.collection, {
      ids: [qdrantPointId(this.options.artifactId, nodeId)],
      with_payload: true,
      with_vector: false,
    });
    return points.some((point) => (point.payload as Partial<ArborPayload> | undefined)?.artifactId === this.options.artifactId);
  }

  async size(): Promise<number> {
    const result = await this.client.count(this.collection, {
      exact: true,
      filter: { must: [this.artifactFilter()] },
    });
    return result.count;
  }

  async entries(): Promise<VectorIndexEntry[]> {
    const entries: VectorIndexEntry[] = [];
    let offset: string | number | Record<string, unknown> | null | undefined;
    do {
      const page = await this.client.scroll(this.collection, {
        limit: 256,
        filter: { must: [this.artifactFilter()] },
        with_payload: true,
        with_vector: true,
        ...(offset !== undefined && offset !== null ? { offset } : {}),
      });
      for (const point of page.points) {
        const payload = point.payload as Partial<ArborPayload> | null | undefined;
        const vector = point.vector;
        if (typeof payload?.nodeId === "string" && Array.isArray(vector)) {
          entries.push({ nodeId: payload.nodeId, vector: vector as number[], metadata: metadataFromPayload(payload) });
        }
      }
      offset = page.next_page_offset as typeof offset;
    } while (offset !== undefined && offset !== null);
    return entries;
  }

  async metadata(nodeIds: readonly NodeId[]): Promise<Map<NodeId, VectorIndexMetadata>> {
    if (nodeIds.length === 0) return new Map();
    const points = await this.client.retrieve(this.collection, {
      ids: nodeIds.map((nodeId) => qdrantPointId(this.options.artifactId, nodeId)),
      with_payload: true,
      with_vector: false,
    });
    const result = new Map<NodeId, VectorIndexMetadata>();
    for (const point of points) {
      const payload = point.payload as Partial<ArborPayload> | null | undefined;
      if (payload?.artifactId === this.options.artifactId && typeof payload.nodeId === "string") {
        result.set(payload.nodeId, metadataFromPayload(payload));
      }
    }
    return result;
  }

  async clear(): Promise<void> {
    await this.client.delete(this.collection, { wait: true, filter: { must: [this.artifactFilter()] } });
  }
}
