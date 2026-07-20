import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const work = mkdtempSync(join(tmpdir(), "arborkit-alpha-pack-"));
const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error("pack smoke must be launched through npm run pack:smoke");
const packages = [".", "packages/mcp", "packages/sqlite", "packages/postgres", "packages/qdrant"];

try {
  const tarballs = [];
  for (const packagePath of packages) {
    const output = execFileSync(process.execPath, [npmCli, "pack", "--json", "--pack-destination", work], {
      cwd: resolve(root, packagePath),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 240_000,
    });
    const jsonStart = [...output.matchAll(/\[\s*\{\s*"id"/g)].at(-1)?.index;
    if (jsonStart === undefined) throw new Error(`npm pack did not return JSON for ${packagePath}`);
    const packed = JSON.parse(output.slice(jsonStart));
    tarballs.push(join(work, packed[0].filename));
  }

  const fixture = join(work, "fixture");
  mkdirSync(fixture);
  writeFileSync(join(fixture, "package.json"), JSON.stringify({ name: "arborkit-alpha-smoke", private: true, type: "module" }));
  writeFileSync(join(fixture, "smoke.mjs"), `
    import { openDurableArbor, sizeBasedDecision } from "arborkit";
    import { createArborMcpServer } from "@arborkit/mcp";
    import { SqliteDurableStore } from "@arborkit/sqlite";
    import { SqliteVecIndex } from "@arborkit/sqlite/sqlite-vec";
    import { PostgresDurableStore, PgVectorIndex } from "@arborkit/postgres";
    import { QdrantVectorIndex } from "@arborkit/qdrant";

    const store = new SqliteDurableStore({ filename: ":memory:" });
    store.migrate();
    const session = await openDurableArbor({
      artifactId: "smoke", store,
      config: { decomposition: { id: "size", version: "1" } },
      arbor: { initial: { value: 0 }, decompose: sizeBasedDecision(1) },
    });
    const result = await session.transact({}, (a) => a.toolset().patch({ path: "/value" }, { op: "set", value: 1 }));
    if (result.version !== 1) throw new Error("durable smoke failed");
    const server = createArborMcpServer({ session, artifactId: "smoke", profile: "admin" });
    await server.close();
    if (![SqliteVecIndex, PostgresDurableStore, PgVectorIndex, QdrantVectorIndex].every((v) => typeof v === "function")) {
      throw new Error("adapter export smoke failed");
    }
    await store.close();
    console.log("PACK_SMOKE_OK");
  `);
  execFileSync(process.execPath, [npmCli, "install", "--no-audit", "--no-fund", ...tarballs], {
    cwd: fixture,
    stdio: "pipe",
    timeout: 300_000,
  });
  const binDirectory = join(fixture, "node_modules", ".bin");
  if (!existsSync(join(binDirectory, "arborkit-mcp")) && !existsSync(join(binDirectory, "arborkit-mcp.cmd"))) {
    throw new Error("arborkit-mcp bin was not linked by clean install");
  }
  const output = execFileSync(process.execPath, ["smoke.mjs"], { cwd: fixture, encoding: "utf8", timeout: 60_000 });
  if (!output.includes("PACK_SMOKE_OK")) throw new Error(`Unexpected smoke output: ${output}`);
  process.stdout.write(output);
} finally {
  rmSync(work, { recursive: true, force: true });
}
