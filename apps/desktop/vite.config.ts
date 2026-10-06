import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath } from 'node:url';
import { cpSync, createReadStream, existsSync } from 'node:fs';
import { join } from 'node:path';

const p = (rel: string) => fileURLToPath(new URL(rel, import.meta.url));

// Excalidraw fetches its fonts at runtime from EXCALIDRAW_ASSET_PATH, falling
// back to a CDN the CSP blocks. They are 13 MB, so they are not committed:
// served straight from node_modules in dev, copied next to the bundle on build.
// Whiteboard.tsx points the asset path at /excalidraw/.
const EXCALIDRAW_FONTS = p('../../node_modules/@excalidraw/excalidraw/dist/prod/fonts');
function excalidrawFonts(): Plugin {
  return {
    name: 'excalidraw-fonts',
    configureServer(server) {
      server.middlewares.use('/excalidraw/fonts', (req, res, next) => {
        const file = join(EXCALIDRAW_FONTS, decodeURIComponent((req.url ?? '').split('?')[0]));
        if (!file.startsWith(EXCALIDRAW_FONTS + '/') || !existsSync(file)) return next();
        res.setHeader('Content-Type', 'font/woff2');
        createReadStream(file).pipe(res);
      });
    },
    writeBundle(options) {
      cpSync(EXCALIDRAW_FONTS, join(options.dir ?? p('./dist'), 'excalidraw/fonts'), { recursive: true });
    },
  };
}

// Desktop shell: Tauri loads built assets from ../dist. Aliases mirror the
// extension so packaged packages resolve the same way across the monorepo.
export default defineConfig({
  plugins: [react(), tailwindcss(), excalidrawFonts()],
  clearScreen: false,
  base: '',
  server: {
    port: 1420,
    strictPort: true,
    watch: {
      ignored: ['**/src-tauri/**'],
    },
  },
  // sqlite-wasm's emscripten glue resolves sqlite3.wasm relative to its own
  // module URL. Pre-bundled into node_modules/.vite/deps, that points at a file
  // Vite never copies there, and the dev server answers the miss with
  // index.html — which the browser then tries to compile as WebAssembly
  // ("module doesn't start with '\0asm'"). Excluding it keeps the package
  // served from its own directory, next to its .wasm.
  optimizeDeps: {
    exclude: ['@sqlite.org/sqlite-wasm'],
  },
  resolve: {
    alias: {
      '@': p('./src'),
      // Deep path on purpose: the @meetcc/shared barrel re-exports modules that
      // reach for chrome.*, which does not exist in a Tauri window.
      '@meetcc/shared/i18n': p('../../packages/shared/src/i18n'),
      // Same reason: types and `switchProvider` are pure, the barrel is not.
      '@meetcc/shared/types': p('../../packages/shared/src/types'),
      '@meetcc/shared/provider': p('../../packages/shared/src/provider'),
      '@meetcc/ai': p('../../packages/ai/src'),
      '@meetcc/store': p('../../packages/store/src'),
      '@meetcc/vault': p('../../packages/vault/src'),
    },
  },
  build: {
    target: 'es2022',
    outDir: 'dist',
  },
});
