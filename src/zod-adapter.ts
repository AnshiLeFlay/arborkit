import type { Json } from "./types";
import { ValidationError } from "./errors";

/** Structural shape of a parser (e.g. a Zod schema). Avoids hard-coupling Arbor to a Zod version. */
export interface ParseSchema {
  parse(value: unknown): unknown;
}

/**
 * Build a `TypeDef.validate` function from any Zod-compatible schema (anything with `.parse()`).
 * Throws `ValidationError` (wrapping the parser's error message) when the value is invalid.
 */
export function zodValidate(schema: ParseSchema, typeName?: string): (value: Json) => void {
  return (value: Json) => {
    try {
      schema.parse(value);
    } catch (err) {
      const details = err instanceof Error ? err.message : String(err);
      throw new ValidationError(typeName, details);
    }
  };
}
