import { describe, it, expect } from "vitest";
import { encodeSegment, decodeSegment, buildPointer, parsePointer } from "../src/jsonpointer";

describe("json pointer segments", () => {
  it("escapes ~ as ~0 and / as ~1 on encode", () => {
    expect(encodeSegment("a/b~c")).toBe("a~1b~0c");
  });

  it("unescapes ~1 to / and ~0 to ~ on decode", () => {
    expect(decodeSegment("a~1b~0c")).toBe("a/b~c");
  });
});

describe("buildPointer / parsePointer", () => {
  it("builds an empty pointer from no segments (root)", () => {
    expect(buildPointer([])).toBe("");
  });

  it("builds a pointer from mixed string/number segments", () => {
    expect(buildPointer(["pages", 0, "title"])).toBe("/pages/0/title");
  });

  it("parses the root pointer to an empty segment list", () => {
    expect(parsePointer("")).toEqual([]);
  });

  it("parses a pointer into decoded segments", () => {
    expect(parsePointer("/pages/0/title")).toEqual(["pages", "0", "title"]);
  });

  it("round-trips segments needing escapes", () => {
    expect(parsePointer(buildPointer(["a/b", "~x"]))).toEqual(["a/b", "~x"]);
  });

  it("throws on a non-root pointer that does not start with '/'", () => {
    expect(() => parsePointer("pages/0")).toThrow();
  });
});
