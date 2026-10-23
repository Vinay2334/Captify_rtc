// Vite build for the extensionRTC (MV3, vanilla JS) extension.
//
// Source lives in src/ (offscreen.html, offscreen.js, service-worker.js,
// rtc-config.js, recorder-processor.js); manifest.json and icons/ live at
// the repo root. `vite build` emits a loadable extension into dist/:
// bundled offscreen page + service worker at the top level, with
// manifest.json, recorder-processor.js and icons/ copied verbatim.
//
// Load it: chrome://extensions -> Developer mode -> Load unpacked -> dist/
import { defineConfig } from "vite";
import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = dirname(fileURLToPath(import.meta.url));
const srcDir = resolve(projectRoot, "src");

// manifest.json, the audio worklet and icons are referenced by literal
// paths (manifest fields, audioWorklet.addModule) so Vite can't see them
// as imports. Copy them verbatim instead of bundling: the worklet must
// stay byte-identical (it relies on the `sampleRate` worklet global and
// registerProcessor) and the manifest must keep its literal filenames.
function copyExtensionAssets() {
  return {
    name: "copy-extension-assets",
    writeBundle(options) {
      const outDir = options.dir || resolve(projectRoot, "dist");
      mkdirSync(outDir, { recursive: true });
      copyFileSync(
        resolve(projectRoot, "manifest.json"),
        resolve(outDir, "manifest.json")
      );
      copyFileSync(
        resolve(srcDir, "recorder-processor.js"),
        resolve(outDir, "recorder-processor.js")
      );
      const iconsDir = resolve(projectRoot, "icons");
      if (existsSync(iconsDir)) {
        cpSync(iconsDir, resolve(outDir, "icons"), { recursive: true });
      }
      copyVADAssets(outDir);
    },
  };
}

function copyVADAssets(outDir) {
  const vadDist = resolve(
    projectRoot,
    "node_modules/@ricky0123/vad-web/dist"
  );

  const ortDist = resolve(
    projectRoot,
    "node_modules/onnxruntime-web/dist"
  );

  const vadOut = resolve(outDir, "vad-assets");
  mkdirSync(vadOut, { recursive: true });

  // Silero model and VAD AudioWorklet.
  for (const file of [
    "silero_vad_v5.onnx",
    "vad.worklet.bundle.min.js",
  ]) {
    copyFileSync(resolve(vadDist, file), resolve(vadOut, file));
  }

  // ONNX Runtime WebAssembly binaries and JS module bindings.
  for (const file of readdirSync(ortDist)) {
    if (file.endsWith(".wasm") || file.endsWith(".mjs")) {
      copyFileSync(resolve(ortDist, file), resolve(vadOut, file));
    }
  }
}

export default defineConfig({
  // src/ is the Vite root so entries emit to the top level of dist/,
  // exactly where manifest.json and the service worker expect them.
  root: srcDir,
  // No public/ dir: extension assets are copied by the plugin above so
  // filenames stay exactly what manifest.json expects.
  publicDir: false,
  build: {
    outDir: resolve(projectRoot, "dist"),
    // Required: outDir sits outside the src/ root, so Vite won't empty
    // it unless forced.
    emptyOutDir: true,
    // Never inline the modulepreload polyfill: it injects an inline
    // <script> which violates the extension CSP (script-src 'self').
    // Chrome 116+ (our minimum) supports native modulepreload anyway.
    modulePreload: { polyfill: false },
    reportCompressedSize: false,
    rollupOptions: {
      input: {
        offscreen: "offscreen.html",
        "service-worker": "service-worker.js",
      },
      output: {
        // Stable, hash-free names: manifest.json references
        // service-worker.js literally, and hash-free output keeps the
        // dist/ diff reviewable.
        entryFileNames: "[name].js",
        chunkFileNames: "chunks/[name].js",
        assetFileNames: "[name][extname]",
      },
    },
  },
  plugins: [copyExtensionAssets()],
});
