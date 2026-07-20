import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  platform: "node",
  target: "node22",
  dts: true,
  splitting: true,
  sourcemap: true,
  clean: true,
  external: ["arborkit", "pg"],
});
