import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { include: ['src/**/*.test.ts'], fileParallelism: false, testTimeout: 20000, setupFiles: ['src/test/setup.ts'] } });
