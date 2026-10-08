import * as esbuild from "esbuild";

const watch = process.argv.includes("--watch");
const production = process.argv.includes("--production");

/** @type {esbuild.BuildOptions} */
const shared = {
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node18",
  minify: production,
  sourcemap: !production,
  logLevel: "info",
};

const builds = [
  {
    ...shared,
    entryPoints: ["src/extension.ts"],
    outfile: "dist/extension.js",
    external: ["vscode"],
  },
  // The language server ships inside the extension, so nothing has to be
  // installed separately. Its dependencies resolve from ../lsp-server/node_modules.
  {
    ...shared,
    entryPoints: ["../lsp-server/src/server.ts"],
    outfile: "dist/server.js",
    // Optional native watcher backend; chokidar falls back to fs.watch without it.
    external: ["fsevents"],
    // jsonc-parser's UMD build hides its requires from the bundler; use its ESM build.
    mainFields: ["module", "main"],
  },
];

if (watch) {
  const contexts = await Promise.all(builds.map((b) => esbuild.context(b)));
  await Promise.all(contexts.map((c) => c.watch()));
} else {
  await Promise.all(builds.map((b) => esbuild.build(b)));
}
