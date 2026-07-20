import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/sqlite-vec.ts"],
  format: ["esm"],
  platform: "node",
  target: "node22",
  dts: true,
  splitting: true,
  sourcemap: true,
  clean: true,
  external: ["arborkit", "sqlite-vec", "better-sqlite3"],
});
