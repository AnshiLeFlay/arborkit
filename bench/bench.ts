// Micro-benchmark suite for Arbor — re-measures the workloads from the
// post-M13 performance review so M17 perf work is validated with real numbers
// and future regressions are visible. Run with: npm run bench
//
// Plain tsx script (NOT vitest). Reference numbers in parentheses are the
// pre-M17 measurements from the review (same machine class, order-of-magnitude
// reference only).

import { performance } from "node:perf_hooks";
import type { Json } from "../src/types";
import { ArtifactTree, type TreeDeps } from "../src/artifact-tree";
import { Addressing } from "../src/addressing";
import { EventLog } from "../src/event-log";
import { Mutator } from "../src/mutator";
import { Navigator } from "../src/navigator";
import { Replay } from "../src/replay";
import { sizeBasedDecision } from "../src/decompose";
import { SeqIdGen } from "../src/ids";
import { FixedClock } from "../src/clock";
import { MemoryVectorIndex } from "../src/vector-index-port";
import { serializeArtifact } from "../src/storage";

// ---------------------------------------------------------------------------
// harness

function fmt(v: number): string {
  return v >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(1) : v >= 1 ? v.toFixed(2) : v.toFixed(4);
}

/** Warm up once, measure once. `perOp` divides the total for per-op reporting. */
async function bench(
  name: string,
  ref: string,
  fn: () => void | Promise<void>,
  opts: { perOp?: number; extra?: () => string } = {},
): Promise<void> {
  await fn(); // warm-up
  const t0 = performance.now();
  await fn();
  const total = performance.now() - t0;
  const value = opts.perOp !== undefined ? total / opts.perOp : total;
  const unit = opts.perOp !== undefined ? "ms/op" : "ms";
  const extra = opts.extra ? `  ${opts.extra()}` : "";
  console.log(`${name.padEnd(44)}${fmt(value).padStart(9)} ${unit.padEnd(5)} (ref: ${ref})${extra}`);
}

/** Deterministic PRNG (mulberry32) for reproducible vector fixtures. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeDeps(): TreeDeps {
  return { idGen: new SeqIdGen(), clock: new FixedClock(0), decision: sizeBasedDecision(200) };
}

// ---------------------------------------------------------------------------
// fixtures

/** Review shape: 100 sections x 100 string leaves = 1 root + 100 + 10,000 = 10,101 nodes.
 *  Sections (objects of 100 strings) exceed 200 bytes -> decomposed; leaves are strings. */
function bigJson(): Json {
  const root: Record<string, Json> = {};
  for (let s = 0; s < 100; s++) {
    const section: Record<string, Json> = {};
    for (let f = 0; f < 100; f++) section[`f${f}`] = `section ${s} field ${f} content`;
    root[`s${s}`] = section;
  }
  return root;
}

function chainJson(depth: number): Json {
  let v: Json = "leaf";
  for (let i = 0; i < depth; i++) v = { a: v };
  return v;
}

// ---------------------------------------------------------------------------
// main

async function main(): Promise<void> {
  console.log("Arbor micro-benchmarks (refs = pre-M17 review numbers)\n");

  // --- build fromJson -------------------------------------------------------
  const json = bigJson();
  let tree!: ArtifactTree;
  await bench(
    "build fromJson (10^4 nodes)",
    "30 ms",
    () => {
      tree = ArtifactTree.fromJson(json, makeDeps());
    },
    { extra: () => `[${tree.size()} nodes]` },
  );

  const addressing = new Addressing(tree);
  const log = new EventLog();
  const mutator = new Mutator(tree, addressing, log, { clock: new FixedClock(0) });
  const navigator = new Navigator(tree, addressing);

  // --- 1000 leaf set() ------------------------------------------------------
  await bench(
    "1000 leaf set() by {path}",
    "39 ms (0.039 ms/op)",
    () => {
      for (let i = 0; i < 1000; i++) {
        mutator.set({ path: `/s${i % 100}/f${(i * 7) % 100}` }, `updated ${i}`);
      }
    },
  );

  // set() keeps node ids stable for leaf replacement, so pre-resolved ids stay valid.
  const leafIds: string[] = [];
  for (let i = 0; i < 1000; i++) {
    leafIds.push(addressing.byPath(`/s${i % 100}/f${(i * 3) % 100}`)!.id);
  }
  await bench(
    "1000 leaf set() by {id}",
    "6.6 ms",
    () => {
      for (let i = 0; i < 1000; i++) {
        mutator.set({ id: leafIds[i] }, `updated-by-id ${i}`);
      }
    },
  );

  // --- transactions (on the 10^4-node tree) ---------------------------------
  await bench("transaction: commit (1 set inside)", "76 ms", () => {
    mutator.transaction(() => {
      mutator.set({ path: "/s0/f0" }, "tx value");
    });
  });

  await bench("transaction: rollback (set + throw)", "198 ms", () => {
    try {
      mutator.transaction(() => {
        mutator.set({ path: "/s0/f0" }, "doomed value");
        throw new Error("rollback");
      });
    } catch {
      /* expected */
    }
  });

  // --- addressing.byPath ----------------------------------------------------
  const wideTree = ArtifactTree.fromJson(
    Array.from({ length: 5000 }, (_, i) => `item-${i}`),
    makeDeps(),
  );
  const wideAddr = new Addressing(wideTree);
  await bench(
    "byPath, tail of 5000-wide array (x1000)",
    "0.39 ms/lookup",
    () => {
      for (let i = 0; i < 1000; i++) wideAddr.byPath("/4999");
    },
    { perOp: 1000 },
  );

  const chainTree = ArtifactTree.fromJson(chainJson(200), makeDeps());
  const chainAddr = new Addressing(chainTree);
  const chainPath = "/a".repeat(200);
  await bench(
    "byPath, depth-200 chain (x1000)",
    "0.14 ms/lookup",
    () => {
      for (let i = 0; i < 1000; i++) chainAddr.byPath(chainPath);
    },
    { perOp: 1000 },
  );

  // --- navigator.find -------------------------------------------------------
  mutator.set({ path: "/s50/f50" }, "tagged node", { tags: ["bench-tag"] });
  await bench(
    "Navigator.find by tag (10^4 nodes, x10)",
    "1.0 ms/call",
    () => {
      for (let i = 0; i < 10; i++) navigator.find({ tag: "bench-tag" }, { limit: 20000 });
    },
    { perOp: 10 },
  );

  await bench(
    'Navigator.find by glob "/s50/**" (x10)',
    "33 ms/call",
    () => {
      for (let i = 0; i < 10; i++) navigator.find({ pathPattern: "/s50/**" }, { limit: 20000 });
    },
    { perOp: 10 },
  );

  // --- vector search --------------------------------------------------------
  const rnd = mulberry32(42);
  const dim = 384;
  const index = new MemoryVectorIndex();
  const entries = Array.from({ length: 10_000 }, (_, i) => ({
    nodeId: `v${i}`,
    vector: Array.from({ length: dim }, () => rnd() * 2 - 1),
  }));
  await index.upsert(entries);
  const query = Array.from({ length: dim }, () => rnd() * 2 - 1);
  await bench(
    "vector search 10^4 x 384d (x10)",
    "~23 ms/search",
    async () => {
      for (let i = 0; i < 10; i++) await index.search(query, 8);
    },
    { perOp: 10 },
  );

  // --- serialize ------------------------------------------------------------
  // Empty vector index: the review's 3 MB figure was tree+log dominated.
  let bytes = 0;
  await bench(
    "serializeArtifact + JSON.stringify",
    "34 ms (3 MB)",
    async () => {
      const stored = await serializeArtifact(tree, log, new MemoryVectorIndex());
      bytes = JSON.stringify(stored).length;
    },
    { extra: () => `[${(bytes / 1e6).toFixed(1)} MB]` },
  );

  // --- replay depth (THE M17 headline) ---------------------------------------
  // sizeBasedDecision(0): the tiny {page:""} root must still decompose so /page resolves.
  const rTree = ArtifactTree.fromJson(
    { page: "" },
    { idGen: new SeqIdGen(), clock: new FixedClock(0), decision: sizeBasedDecision(0) },
  );
  const rAddr = new Addressing(rTree);
  const rLog = new EventLog();
  const rMutator = new Mutator(rTree, rAddr, rLog, { clock: new FixedClock(0) });
  const kb = "x".repeat(1024);
  for (let i = 0; i < 3000; i++) rMutator.set({ path: "/page" }, `${kb}-${i}`);
  const replay = new Replay(rTree, rLog);
  await bench("Replay.reconstructValueAt(0), 3000 ev", "8,404 ms (3,101 ev)", () => {
    replay.reconstructValueAt(0);
  });

  console.log("\nNote: absolute numbers are machine-dependent; refs are order-of-magnitude only.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
