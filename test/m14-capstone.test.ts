import { describe, it, expect } from "vitest";
import { ArtifactTree, type TreeDeps } from "../src/artifact-tree";
import { Addressing } from "../src/addressing";
import { EventLog } from "../src/event-log";
import { Mutator } from "../src/mutator";
import { Replay } from "../src/replay";
import { makeToolset } from "../src/toolset";
import { sizeBasedDecision } from "../src/decompose";
import { SeqIdGen } from "../src/ids";
import { FixedClock } from "../src/clock";

describe("M14 capstone: adversarial agent traffic", () => {
  it("malicious/buggy patches get structured errors; state and history stay intact", async () => {
    const deps: TreeDeps = { idGen: new SeqIdGen(), clock: new FixedClock(0), decision: sizeBasedDecision(1) };
    const initial = { work: { draft: "text", meta: { k: "v" } }, other: { x: "1", y: "2", z: "3" } };
    const tree = ArtifactTree.fromJson(initial, deps);
    const addressing = new Addressing(tree);
    const log = new EventLog();
    const mutator = new Mutator(tree, addressing, log, { clock: new FixedClock(0) });
    const agent = makeToolset(
      { tree, addressing, log, mutator },
      { owner: "agent-1", writeScope: "/work", readScope: "/work" },
    );

    // 1. cycle attack: move a container into its own subtree → INVALID_OP, no hang
    const r1 = await agent.patch({ path: "/work" }, { op: "move", to: { path: "/work/meta" }, key: "loop" });
    expect(r1.ok).toBe(false);
    if (!r1.ok) expect(r1.error.code).toBe("INVALID_OP");

    // 2. shadow attack: move onto an existing key → INVALID_OP, old value intact
    const r2 = await agent.patch(
      { path: "/work/draft" },
      { op: "move", to: { path: "/work/meta" }, key: "k" },
    );
    expect(r2.ok).toBe(false);
    expect(tree.toJson(addressing.byPath("/work/meta/k")!.id)).toBe("v");

    // 3. aliasing attack: keep mutating the payload after a successful patch
    const payload = { title: "clean" };
    const r3 = await agent.patch({ path: "/work/draft" }, { op: "set", value: payload });
    expect(r3.ok).toBe(true);
    payload.title = "INJECTED";
    expect(tree.toJson(addressing.byPath("/work/draft")!.id)).toEqual({ title: "clean" });

    // 4. scoped find under a tiny limit still sees in-scope nodes
    const r4 = await agent.find({ pathPattern: "/**" }, { limit: 2 });
    expect(r4.ok).toBe(true);
    if (r4.ok) {
      expect(r4.value.length).toBe(2);
      for (const h of r4.value) expect(h.path === "/work" || h.path.startsWith("/work/")).toBe(true);
    }

    // 5. history the agent reads cannot be used to corrupt the log
    const r5 = await agent.history({ path: "/work/draft" });
    expect(r5.ok).toBe(true);
    if (r5.ok && r5.value.length > 0) (r5.value[0]! as { after?: unknown }).after = "corrupted";

    // 6. after all attacks: time-travel to version 0 reproduces the initial artifact
    const replay = new Replay(tree, log);
    expect(replay.reconstructValueAt(0)).toEqual(initial);
  });
});
