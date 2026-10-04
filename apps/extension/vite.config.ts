import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath } from 'node:url';

const p = (rel: string) => fileURLToPath(new URL(rel, import.meta.url));

// Sanitize unused pdfobject CDN URL in jsPDF which triggers Chrome Web Store
// MV3 remotely hosted code violations (Blue Argon).
function sanitizePdfobject() {
  return {
    name: 'sanitize-pdfobject',
    transform(code: string) {
      if (code.includes('https://cdnjs.cloudflare.com/ajax/libs/pdfobject/')) {
        return {
          code: code.replace(
            /https:\/\/cdnjs\.cloudflare\.com\/ajax\/libs\/pdfobject\/[^\s"'`]+\.js/g,
            '',
          ),
          map: null,
        };
      }
      return null;
    },
  };
}

// base '' -> relative asset URLs, required inside chrome-extension:// pages
export default defineConfig({
  plugins: [react(), tailwindcss(), sanitizePdfobject()],
  base: '',
  resolve: {
    alias: {
      '@': p('./src'),
      canvg: p('./src/stubs/canvg.ts'),
      '@meetcc/shared/i18n': p('../../packages/shared/src/i18n'),
      '@meetcc/shared': p('../../packages/shared/src'),
      '@meetcc/ai': p('../../packages/ai/src'),
      '@meetcc/meeting': p('../../packages/meeting/src'),
      '@meetcc/store': p('../../packages/store/src'),
      '@meetcc/exporters': p('../../packages/exporters/src'),
    },
  },
  build: {
    // Chromium-only runtime (MV3 extension) — allows top-level await
    target: 'chrome110',
    outDir: 'dist',
    rollupOptions: {
      input: {
        app: p('./index.html'),
        background: p('./src/background.ts'),
      },
      output: {
        // service worker must be a stable filename at the bundle root
        entryFileNames: (chunk) =>
          chunk.name === 'background' ? 'background.js' : 'assets/[name]-[hash].js',
      },
    },
  },
});
