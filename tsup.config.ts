import { defineConfig } from "tsup";

export default defineConfig({
  // Every public module is its own entry (incl. the barrel), so the "./*"
  // subpath exports map cleanly onto dist/<module>.js.
  entry: ["src/*.ts"],
  format: ["esm"],
  platform: "node",
  target: "node22",
  dts: true,
  // Code splitting ON: without it every subpath entry bundles its OWN copies of
  // shared classes, so `instanceof` breaks across mixed root/subpath imports
  // (e.g. toolset's `e instanceof ArborError` failing against a Mutator error).
  // Chunk files stay private: package.json enumerates exports explicitly, so
  // hash-named chunks are not importable.
  splitting: true,
  sourcemap: true,
  clean: true,
});
