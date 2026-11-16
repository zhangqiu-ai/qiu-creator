import { defineConfig } from 'vitest/config';

// Separate from vite.config.ts, whose root is the renderer folder.
export default defineConfig({
  root: import.meta.dirname,
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
});
