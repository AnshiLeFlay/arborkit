import type { Json } from "./types";

/** Definition of a registered node type. */
export interface TypeDef {
  /** Validate a value about to be stored at a node of this type. Throw to reject. */
  validate?: (value: Json) => void;
  /** Override the size-based decomposition for nodes of this type. */
  decompose?: "opaque" | "children";
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
}
