import { describe, it, expect } from "vitest";
import {
  ArborError,
  NodeNotFoundError,
  ScopeViolationError,
  StaleVersionError,
  InvalidOpError,
} from "../src/errors";

describe("typed errors", () => {
  it("NodeNotFoundError carries code and ref and is an ArborError", () => {
    const e = new NodeNotFoundError({ path: "/pages/9" });
    expect(e).toBeInstanceOf(ArborError);
    expect(e).toBeInstanceOf(Error);
    expect(e.code).toBe("NODE_NOT_FOUND");
    expect(e.ref).toEqual({ path: "/pages/9" });
  });

  it("ScopeViolationError carries target path and allowed scope", () => {
    const e = new ScopeViolationError("/pages/1", "/pages/0");
    expect(e.code).toBe("SCOPE_VIOLATION");
    expect(e.targetPath).toBe("/pages/1");
    expect(e.scope).toBe("/pages/0");
  });

  it("StaleVersionError carries id, expected and actual", () => {
    const e = new StaleVersionError("n3", 1, 2);
    expect(e.code).toBe("STALE_VERSION");
    expect(e.id).toBe("n3");
    expect(e.expected).toBe(1);
    expect(e.actual).toBe(2);
  });

  it("InvalidOpError carries a code and message", () => {
    const e = new InvalidOpError("cannot remove root");
    expect(e.code).toBe("INVALID_OP");
    expect(e.message).toContain("cannot remove root");
  });
});
