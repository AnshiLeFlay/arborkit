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
    public readonly scope: string,
  ) {
    super("SCOPE_VIOLATION", `Access outside scope: ${targetPath} (scope: ${scope})`);
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

export class StaleArtifactError extends ArborError {
  constructor(
    public readonly artifactId: string,
    public readonly expected: number,
    public readonly actual: number,
  ) {
    super("STALE_ARTIFACT", `Stale artifact ${artifactId}: expected ${expected}, actual ${actual}`);
  }
}

export class IdempotencyConflictError extends ArborError {
  constructor(public readonly key: string) {
    super("IDEMPOTENCY_CONFLICT", `Idempotency key ${JSON.stringify(key)} was already used for a different request`);
  }
}

export class ConfigMismatchError extends ArborError {
  constructor(
    public readonly storedFingerprint: string,
    public readonly expectedFingerprint: string,
  ) {
    super(
      "CONFIG_MISMATCH",
      `Artifact configuration mismatch: stored ${storedFingerprint}, expected ${expectedFingerprint}`,
    );
  }
}

export class MigrationRequiredError extends ArborError {
  constructor(message = "Persistence schema migration is required") {
    super("MIGRATION_REQUIRED", message);
  }
}

export class VectorDimensionMismatchError extends ArborError {
  constructor(
    public readonly expected: number,
    public readonly actual: number,
  ) {
    super("VECTOR_DIMENSION_MISMATCH", `Vector dimensions mismatch: expected ${expected}, actual ${actual}`);
  }
}
