import { defineConfig } from 'vite';

// StudyForge is a plain Vite + vanilla JS app. The only build requirement is
// that Firebase AI Logic (firebase/ai) ships in the bundle and is actually
// called at runtime — which src/ai.js does.
export default defineConfig({
  build: {
    outDir: 'dist',
    sourcemap: false,
  },
  server: {
    port: 5173,
    host: '127.0.0.1',
  },
});
