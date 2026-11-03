import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// GitHub Pages では https://check5004.github.io/dtx-mania-web-editor/ で配信される
export default defineConfig({
  base: '/dtx-mania-web-editor/',
  plugins: [react()],
  build: {
    rollupOptions: {
      // bench.html は耳コピの自動推定の精度テスト（docs/bench.md）
      input: { main: 'index.html', bench: 'bench.html' },
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
