import { fileURLToPath } from 'node:url';

export default {
  resolve: { alias: { obsidian: fileURLToPath(new URL('./src/test/obsidian.ts', import.meta.url)) } },
  test: {
    include: ['src/**/*.test.ts'],
  },
};
