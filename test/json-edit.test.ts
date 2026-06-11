import { describe, it, expect } from "vitest";
import { getAtPath, setAtPath, removeAtPath, insertAtPath } from "../src/json-edit";

describe("getAtPath", () => {
  it("reads root and nested object/array paths", () => {
    expect(getAtPath({ a: { b: 1 } }, "")).toEqual({ a: { b: 1 } });
    expect(getAtPath({ a: { b: 1 } }, "/a/b")).toBe(1);
    expect(getAtPath({ a: [10, 20] }, "/a/1")).toBe(20);
  });
  it("returns undefined for a missing path", () => {
    expect(getAtPath({ a: 1 }, "/b")).toBeUndefined();
    expect(getAtPath({ a: [1] }, "/a/5")).toBeUndefined();
  });
});

describe("setAtPath", () => {
  it("replaces at a nested path without mutating the original", () => {
    const v = { a: { b: 1 } };
    const r = setAtPath(v, "/a/b", 2);
    expect(r).toEqual({ a: { b: 2 } });
    expect(v).toEqual({ a: { b: 1 } });
  });
  it("replaces the root when the pointer is empty", () => {
    expect(setAtPath({ a: 1 }, "", { z: 9 })).toEqual({ z: 9 });
  });
  it("replaces an array element by index", () => {
    expect(setAtPath({ a: [1, 2] }, "/a/1", 9)).toEqual({ a: [1, 9] });
  });
});

describe("removeAtPath", () => {
  it("deletes an object key", () => {
    expect(removeAtPath({ a: 1, b: 2 }, "/b")).toEqual({ a: 1 });
  });
  it("splices an array element out", () => {
    expect(removeAtPath({ a: [1, 2, 3] }, "/a/1")).toEqual({ a: [1, 3] });
  });
});

describe("insertAtPath", () => {
  it("sets a new object key", () => {
    expect(insertAtPath({ a: 1 }, "/b", 2)).toEqual({ a: 1, b: 2 });
  });
  it("splices into an array at an index, shifting the rest", () => {
    expect(insertAtPath({ a: [1, 3] }, "/a/1", 2)).toEqual({ a: [1, 2, 3] });
  });
});
