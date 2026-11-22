import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const apiTarget = process.env.API_URL ?? 'http://127.0.0.1:8042';

export default defineConfig({
  plugins: [react()],
  // One copy of @codemirror/state and /view in the bundle (see scripts/check-cm.mjs).
  resolve: { dedupe: ['@codemirror/state', '@codemirror/view'] },
  server: {
    port: 5173,
    proxy: { '/api': apiTarget },
  },
  preview: {
    port: 4173,
    proxy: { '/api': apiTarget },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
    // Separate vendor chunks so a redeploy of app code keeps the editor cached on phones.
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (/node_modules\/(@codemirror|@lezer|style-mod|w3c-keyname|crelt)\//.test(id)) return 'codemirror';
          if (/node_modules\/(react|react-dom|scheduler)\//.test(id)) return 'react';
          return undefined;
        },
      },
    },
  },
});
