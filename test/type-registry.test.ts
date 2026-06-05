import { describe, it, expect } from "vitest";
import { TypeRegistry } from "../src/type-registry";
import { ValidationError, ArborError } from "../src/errors";

describe("ValidationError", () => {
  it("carries code, type, and details and is an ArborError", () => {
    const e = new ValidationError("PageContent", "title is required");
    expect(e).toBeInstanceOf(ArborError);
    expect(e.code).toBe("VALIDATION_ERROR");
    expect(e.type).toBe("PageContent");
    expect(e.details).toBe("title is required");
  });

  it("allows an undefined type", () => {
    const e = new ValidationError(undefined, "bad");
    expect(e.type).toBeUndefined();
    expect(e.message).toContain("bad");
  });
});

describe("TypeRegistry", () => {
  it("registers and retrieves a type definition", () => {
    const r = new TypeRegistry();
    const def = { decompose: "opaque" as const };
    r.register("PageContent", def);
    expect(r.get("PageContent")).toBe(def);
    expect(r.has("PageContent")).toBe(true);
  });

  it("returns undefined and false for an unknown type", () => {
    const r = new TypeRegistry();
    expect(r.get("Nope")).toBeUndefined();
    expect(r.has("Nope")).toBe(false);
  });
});
