import esbuild from "esbuild";
import process from "process";
import builtins from "builtin-modules";

const prod = process.argv[2] === "production";

const context = await esbuild.context({
  entryPoints: ["src/main.ts"],
  bundle: true,
  external: [
    "obsidian",
    "electron",
    "@codemirror/autocomplete",
    "@codemirror/collab",
    "@codemirror/commands",
    "@codemirror/language",
    "@codemirror/lint",
    "@codemirror/search",
    "@codemirror/state",
    "@codemirror/view",
    "@lezer/common",
    "@lezer/highlight",
    "@lezer/lr",
    ...builtins,
  ],
  // Obsidian's Electron renderer looks like Node, so transformers.js reaches for
  // onnxruntime-node (native .node binaries we can't ship). Force the wasm web
  // runtime instead — it's portable and bundles cleanly.
  alias: {
    "onnxruntime-node": "onnxruntime-web",
  },
  format: "cjs",
  target: "es2018",
  logLevel: "info",
  sourcemap: prod ? false : "inline",
  treeShaking: true,
  // transformers.js calls fileURLToPath(import.meta.url) at load; in CJS output
  // import.meta.url is undefined and throws. Define a valid (dummy) file URL — it
  // only seeds the *local* model dir, which we don't use (models fetch remotely).
  define: {
    "import.meta.url": JSON.stringify("file:///C:/"),
  },
  outfile: "main.js",
});

if (prod) {
  await context.rebuild();
  process.exit(0);
} else {
  await context.watch();
}
