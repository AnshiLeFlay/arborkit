import { describe, it, expect, afterAll } from "vitest";
import { execSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const work = mkdtempSync(join(tmpdir(), "arbor-m11-pack-"));

const SMOKE = `
import { ArtifactTree, Addressing, EventLog, Mutator, makeToolset, sizeBasedDecision, SeqIdGen, SystemClock, serializeArtifact, restoreArtifact, MemoryStorage, MemoryVectorIndex } from "arbor";
import { Replay } from "arbor/replay";

const deps = { idGen: new SeqIdGen(), clock: new SystemClock(), decision: sizeBasedDecision(1) };
const tree = ArtifactTree.fromJson({ pages: {} }, deps);
const addressing = new Addressing(tree);
const log = new EventLog();
const mutator = new Mutator(tree, addressing, log, { clock: deps.clock });

const tools = makeToolset({ tree, addressing, log, mutator }, { owner: "smoke", writeScope: "/pages" });
const ins = await tools.patch({ path: "/pages" }, { op: "insert", key: "home", value: { title: "Home" } });
if (!ins.ok) throw new Error("insert failed: " + JSON.stringify(ins));
const got = await tools.get({ path: "/pages/home" });
if (!got.ok || got.value.content.title !== "Home") throw new Error("get failed");
const refused = await tools.patch({ path: "/secret" }, { op: "set", value: 1 });
if (refused.ok) throw new Error("scope violation not refused");

const store = new MemoryStorage();
await store.save(serializeArtifact(tree, log, new MemoryVectorIndex()));
const loaded = await store.load();
const { tree: rtree } = restoreArtifact(loaded, deps, new MemoryVectorIndex());
if (JSON.stringify(rtree.toJson()) !== JSON.stringify(tree.toJson())) throw new Error("roundtrip failed");

const replay = new Replay(tree, log);
const before = replay.getAt("/pages/home", 0);
if (before !== undefined) throw new Error("expected node absent at v0");

console.log("SMOKE_OK");
`;

describe("M11 capstone: packed tarball runs in plain Node ESM (no bundler, no aliases)", () => {
  afterAll(() => {
    rmSync(work, { recursive: true, force: true });
  });

  it("npm pack → install into a bare fixture → smoke script passes", () => {
    // 1. pack (prepack runs the build)
    execSync(`npm pack --pack-destination "${work}"`, { cwd: repoRoot, stdio: "pipe", timeout: 180_000 });
    const tarball = readdirSync(work).find((f) => f.endsWith(".tgz"));
    expect(tarball).toBeDefined();

    // 2. bare ESM fixture — no TypeScript, no tsconfig, no aliases
    const fixture = join(work, "fixture");
    execSync(`node -e "require('fs').mkdirSync('${fixture.replace(/\\/g, "/")}', {recursive:true})"`, { stdio: "pipe" });
    writeFileSync(join(fixture, "package.json"), JSON.stringify({ name: "smoke", private: true, type: "module" }));
    writeFileSync(join(fixture, "smoke.mjs"), SMOKE);
    execSync(`npm install --no-audit --no-fund "${join(work, tarball!)}"`, { cwd: fixture, stdio: "pipe", timeout: 180_000 });

    // 3. run the smoke under plain node
    const out = execSync("node smoke.mjs", { cwd: fixture, encoding: "utf8", timeout: 60_000 });
    expect(out).toContain("SMOKE_OK");
  }, 300_000);
});
