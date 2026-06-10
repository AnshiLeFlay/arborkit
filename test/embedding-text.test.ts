import { describe, it, expect } from "vitest";
import { ArtifactTree, type TreeDeps } from "../src/artifact-tree";
import { Addressing } from "../src/addressing";
import { toEmbeddingText, textHash } from "../src/embedding-text";
import { sizeBasedDecision } from "../src/decompose";
import { SeqIdGen } from "../src/ids";
import { FixedClock } from "../src/clock";

function leafFor(json: unknown, path: string) {
  const deps: TreeDeps = { idGen: new SeqIdGen(), clock: new FixedClock(0), decision: sizeBasedDecision(1) };
  const tree = ArtifactTree.fromJson(json as never, deps);
  const addressing = new Addressing(tree);
  return { tree, node: addressing.byPath(path)! };
}

describe("toEmbeddingText", () => {
  it("returns a string leaf's value verbatim", () => {
    const { node } = leafFor({ t: "Hello" }, "/t");
    expect(toEmbeddingText(node, "Hello")).toBe("Hello");
  });

  it("returns null for a numeric/boolean leaf (not worth embedding by default)", () => {
    const { node } = leafFor({ n: 42 }, "/n");
    expect(toEmbeddingText(node, 42)).toBeNull();
  });

  it("returns null for a structural container by default", () => {
    const { tree } = leafFor({ a: { b: 1 } }, "/a");
    const root = tree.root();
    expect(toEmbeddingText(root, tree.toJson(root.id))).toBeNull();
  });

  it("uses a type's embedText override when present", () => {
    const { node } = leafFor({ t: "x" }, "/t");
    const typeDef = { embedText: (v: unknown) => `custom:${JSON.stringify(v)}` };
    expect(toEmbeddingText(node, "x", typeDef)).toBe('custom:"x"');
  });
});

describe("textHash", () => {
  it("is deterministic and differs for different text", () => {
    expect(textHash("abc")).toBe(textHash("abc"));
    expect(textHash("abc")).not.toBe(textHash("abd"));
  });
});
