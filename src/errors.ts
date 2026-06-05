import type { NodeId } from "./types";

/** A reference to a node: by stable id or by JSON Pointer path. */
export type Ref = { id: NodeId } | { path: string };

export class ArborError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class NodeNotFoundError extends ArborError {
  constructor(public readonly ref: Ref) {
    super("NODE_NOT_FOUND", `Node not found: ${JSON.stringify(ref)}`);
  }
}

export class ScopeViolationError extends ArborError {
  constructor(
    public readonly targetPath: string,
    public readonly writeScope: string,
  ) {
    super("SCOPE_VIOLATION", `Write outside scope: ${targetPath} not within ${writeScope}`);
  }
}

export class StaleVersionError extends ArborError {
  constructor(
    public readonly id: NodeId,
    public readonly expected: number,
    public readonly actual: number,
  ) {
    super("STALE_VERSION", `Stale version for ${id}: expected ${expected}, actual ${actual}`);
  }
}

export class InvalidOpError extends ArborError {
  constructor(message: string) {
    super("INVALID_OP", message);
  }
}

export class ValidationError extends ArborError {
  constructor(
    public readonly type: string | undefined,
    public readonly details: string,
  ) {
    super("VALIDATION_ERROR", `Validation failed${type ? ` for type ${type}` : ""}: ${details}`);
  }
}
