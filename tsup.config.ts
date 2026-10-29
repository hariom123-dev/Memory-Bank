import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    "cli/index": "src/cli/entry.ts",
    "cli/healthcheck": "src/cli/healthcheck.ts",
    index: "src/index.ts",
  },
  format: ["esm"],
  dts: false,
  splitting: false,
  sourcemap: true,
  clean: false,
  minify: true,
  shims: true,
  external: [
    "better-sqlite3",
    "@xenova/transformers",
    "sharp",
    "fsevents",
  ],
});
