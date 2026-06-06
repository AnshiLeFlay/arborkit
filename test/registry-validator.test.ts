import { describe, it, expect } from "vitest";
import { TypeRegistry } from "../src/type-registry";
import { makeRegistryValidator } from "../src/registry-validator";

describe("makeRegistryValidator", () => {
  it("runs the registered validate() for the given type", () => {
    const r = new TypeRegistry();
    r.register("Num", { validate: (v) => { if (typeof v !== "number") throw new Error("not a number"); } });
    const validate = makeRegistryValidator(r);
    expect(() => validate({ node: null, proposed: "x", type: "Num", op: "set" })).toThrow("not a number");
    expect(() => validate({ node: null, proposed: 5, type: "Num", op: "set" })).not.toThrow();
  });

  it("is a no-op when type is undefined", () => {
    const r = new TypeRegistry();
    const validate = makeRegistryValidator(r);
    expect(() => validate({ node: null, proposed: "anything", type: undefined, op: "insert" })).not.toThrow();
  });

  it("is a no-op when the type is unregistered or has no validate", () => {
    const r = new TypeRegistry();
    r.register("NoValidate", { decompose: "opaque" });
    const validate = makeRegistryValidator(r);
    expect(() => validate({ node: null, proposed: "x", type: "Unknown", op: "set" })).not.toThrow();
    expect(() => validate({ node: null, proposed: "x", type: "NoValidate", op: "set" })).not.toThrow();
  });
});
