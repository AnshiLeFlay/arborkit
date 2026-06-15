import { defineConfig } from "tsup";

export default defineConfig({
  // Every public module is its own entry (incl. the barrel), so the "./*"
  // subpath exports map cleanly onto dist/<module>.js.
  entry: ["src/*.ts"],
  format: ["esm"],
  platform: "node",
  target: "node20",
  dts: true,
  splitting: true, // shared code goes into chunks instead of being duplicated per entry
  sourcemap: true,
  clean: true,
});
