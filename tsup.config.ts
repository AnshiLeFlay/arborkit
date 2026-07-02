import { defineConfig } from "tsup";

export default defineConfig({
  // Every public module is its own entry (incl. the barrel), so the "./*"
  // subpath exports map cleanly onto dist/<module>.js.
  entry: ["src/*.ts"],
  format: ["esm"],
  platform: "node",
  target: "node20",
  dts: true,
  // No code splitting: hash-named chunk-*.js files would be importable through
  // the "./*" exports map, becoming accidental public API. Duplication is fine.
  splitting: false,
  sourcemap: true,
  clean: true,
});
