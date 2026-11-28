import { defineConfig } from 'vite';

// The configurator runs the code it writes, which may use any class of the core, so the app holds the whole core in
// one piece; the templates load apart from it.
export default defineConfig({
  build: { chunkSizeWarningLimit: 800 },
});
