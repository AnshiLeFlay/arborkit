import { describe, it, expect } from "vitest";
import { SeqIdGen } from "../src/ids";
import { FixedClock } from "../src/clock";

describe("SeqIdGen", () => {
  it("produces deterministic sequential ids", () => {
    const g = new SeqIdGen();
    expect([g.next(), g.next(), g.next()]).toEqual(["n0", "n1", "n2"]);
  });

  it("honors a custom prefix", () => {
    const g = new SeqIdGen("x");
    expect([g.next(), g.next()]).toEqual(["x0", "x1"]);
  });
});

describe("FixedClock", () => {
  it("returns a constant value until advanced", () => {
    const c = new FixedClock(100);
    expect(c.now()).toBe(100);
    expect(c.now()).toBe(100);
    c.advance(5);
    expect(c.now()).toBe(105);
  });
});
