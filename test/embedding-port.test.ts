import { describe, it, expect } from "vitest";
import { MockEmbeddingPort } from "../src/embedding-port";

describe("MockEmbeddingPort", () => {
  it("returns one vector per input text, each of the configured dimension", async () => {
    const port = new MockEmbeddingPort(8);
    const vecs = await port.embed(["hello", "world"]);
    expect(vecs.length).toBe(2);
    expect(vecs[0].length).toBe(8);
    expect(port.dims).toBe(8);
  });

  it("is deterministic: identical text yields an identical vector", async () => {
    const port = new MockEmbeddingPort();
    const [a] = await port.embed(["same"]);
    const [b] = await port.embed(["same"]);
    expect(a).toEqual(b);
  });

  it("different text yields a different vector", async () => {
    const port = new MockEmbeddingPort();
    const [a] = await port.embed(["alpha"]);
    const [b] = await port.embed(["beta"]);
    expect(a).not.toEqual(b);
  });
});
