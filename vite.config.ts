import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// GitHub Pages では https://check5004.github.io/dtx-mania-web-editor/ で配信される
export default defineConfig({
  base: '/dtx-mania-web-editor/',
  plugins: [react()],
  // ドラムの採譜（src/transcribe）の ONNX Runtime は、WASM の場所を自分で渡すので事前バンドルしない
  // （開発サーバーが途中で依存を見つけてページを読み込み直すのも防ぐ）
  optimizeDeps: { exclude: ['onnxruntime-web'] },
  worker: { format: 'es' },
  build: {
    rollupOptions: {
      // bench.html は耳コピの自動推定の精度テスト（docs/bench.md）
      input: { main: 'index.html', bench: 'bench.html' },
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // 言語は日本語で始める（src/test-setup.ts）
    setupFiles: ['src/test-setup.ts'],
  },
});
