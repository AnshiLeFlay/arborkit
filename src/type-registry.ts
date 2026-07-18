import type { Json } from "./types";

/** Definition of a registered node type. */
export interface TypeDef {
  /** Human-readable description exposed by adapters such as MCP. */
  description?: string;
  /** Serializable JSON Schema metadata for clients. Validation remains opt-in via `validate`. */
  jsonSchema?: Record<string, unknown>;
  /** Validate a value about to be stored at a node of this type. Throw to reject. */
  validate?: (value: Json) => void;
  /** Override the size-based decomposition for nodes of this type. */
  decompose?: "opaque" | "children";
  /** Override the text used to embed nodes of this type. Return null to skip embedding. */
  embedText?: (value: Json) => string | null;
}

/** Serializable view of a registered type. Function implementations never cross the boundary. */
export interface TypeMetadata {
  name: string;
  description?: string;
  jsonSchema?: Record<string, unknown>;
  decompose?: "opaque" | "children";
  hasValidator: boolean;
  hasEmbedText: boolean;
}

/** A registry of named node types (validator + decompose override). */
export class TypeRegistry {
  private readonly types = new Map<string, TypeDef>();

  register(name: string, def: TypeDef): void {
    this.types.set(name, def);
  }

  get(name: string): TypeDef | undefined {
    return this.types.get(name);
  }

  has(name: string): boolean {
    return this.types.has(name);
  }

  /** Deterministic, detached metadata suitable for JSON and remote adapters. */
  list(): TypeMetadata[] {
    return [...this.types.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([name, def]) => {
        const metadata: TypeMetadata = {
          name,
          hasValidator: def.validate !== undefined,
          hasEmbedText: def.embedText !== undefined,
        };
        if (def.description !== undefined) metadata.description = def.description;
        if (def.jsonSchema !== undefined) metadata.jsonSchema = structuredClone(def.jsonSchema);
        if (def.decompose !== undefined) metadata.decompose = def.decompose;
        return metadata;
      });
  }
}
