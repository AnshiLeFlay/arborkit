import { describe, it, expect } from "vitest";
import { z } from "zod";
import { zodValidate } from "../src/zod-adapter";
import { ValidationError } from "../src/errors";

const schema = z.object({ title: z.string() });

describe("zodValidate", () => {
  it("passes a value that matches the schema", () => {
    const validate = zodValidate(schema, "T");
    expect(() => validate({ title: "ok" })).not.toThrow();
  });

  it("throws ValidationError for a value that fails the schema", () => {
    const validate = zodValidate(schema, "T");
    expect(() => validate({ title: 5 })).toThrow(ValidationError);
  });

  it("includes the type name on the thrown error", () => {
    const validate = zodValidate(schema, "MyType");
    let caught: unknown;
    try {
      validate({});
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ValidationError);
    expect((caught as ValidationError).type).toBe("MyType");
  });
});
