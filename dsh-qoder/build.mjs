import { build } from "esbuild";

await build({
  entryPoints: ["src/index.ts"],
  outfile: "index.js",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  sourcemap: false,
  logLevel: "info",
});
