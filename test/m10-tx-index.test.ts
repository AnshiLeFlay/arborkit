import { describe, it, expect } from "vitest";
import { ArtifactTree, type TreeDeps } from "../src/artifact-tree";
import { Addressing } from "../src/addressing";
import { EventLog } from "../src/event-log";
import { Mutator } from "../src/mutator";
import { SemanticIndex } from "../src/semantic-index";
import { MockEmbeddingPort } from "../src/embedding-port";
import { MemoryVectorIndex } from "../src/vector-index-port";
import { sizeBasedDecision } from "../src/decompose";
import { SeqIdGen } from "../src/ids";
import { FixedClock } from "../src/clock";

function setup() {
  const deps: TreeDeps = { idGen: new SeqIdGen(), clock: new FixedClock(0), decision: sizeBasedDecision(1) };
  const tree = ArtifactTree.fromJson({ docs: {} }, deps);
  const addressing = new Addressing(tree);
  const log = new EventLog();
  const index = new SemanticIndex(tree, addressing, new MockEmbeddingPort(), new MemoryVectorIndex());
  const mutator = new Mutator(tree, addressing, log, { clock: new FixedClock(0), ...index.hooks() });
  return { tree, index, mutator };
}

describe("M10 C3: transaction rollback restores the stale set", () => {
  it("a failed transaction leaves staleCount exactly as before", () => {
    const { index, mutator } = setup();
    mutator.insert({ path: "/docs" }, "keep", "existing text");
    const before = index.staleCount(); // 1
    expect(() =>
      mutator.transaction(() => {
        mutator.insert({ path: "/docs" }, "doomed", "rolled back text");
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(index.staleCount()).toBe(before); // no ghost stale entry for the rolled-back node
  });

  it("a successful transaction keeps its stale marks", () => {
    const { index, mutator } = setup();
    mutator.transaction(() => {
      mutator.insert({ path: "/docs" }, "a", "text one");
      mutator.insert({ path: "/docs" }, "b", "text two");
    });
    expect(index.staleCount()).toBe(2);
  });
});
