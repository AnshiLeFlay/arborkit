import { describe, it, expect } from "vitest";
import { matchGlob } from "../src/path-glob";

describe("matchGlob", () => {
  it("matches a single-segment wildcard", () => {
    expect(matchGlob("/pages/*", "/pages/0")).toBe(true);
    expect(matchGlob("/pages/*", "/pages/home")).toBe(true);
  });

  it("does not let a single wildcard span multiple segments", () => {
    expect(matchGlob("/pages/*", "/pages/0/title")).toBe(false);
  });

  it("matches a wildcard in the middle", () => {
    expect(matchGlob("/pages/*/title", "/pages/0/title")).toBe(true);
    expect(matchGlob("/pages/*/title", "/pages/0/body")).toBe(false);
  });

  it("matches ** across any depth, including zero segments", () => {
    expect(matchGlob("/pages/**", "/pages")).toBe(true);
    expect(matchGlob("/pages/**", "/pages/0")).toBe(true);
    expect(matchGlob("/pages/**", "/pages/0/title")).toBe(true);
    expect(matchGlob("/**", "/a/b/c")).toBe(true);
  });

  it("matches the root pattern to the root path", () => {
    expect(matchGlob("", "")).toBe(true);
  });

  it("rejects a literal mismatch", () => {
    expect(matchGlob("/a", "/b")).toBe(false);
    expect(matchGlob("/a/b", "/a")).toBe(false);
  });
});
