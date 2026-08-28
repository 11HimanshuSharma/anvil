import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    target: 'es2022',
    sourcemap: true,
    rollupOptions: {
      // Two entry points: the workspace, and the §1 go/no-go registration probe.
      input: { main: 'index.html', probe: 'probe.html' },
    },
  },
  server: { port: 5173, strictPort: true },
  preview: { port: 4173, strictPort: true },
});
