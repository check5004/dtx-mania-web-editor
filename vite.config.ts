import { readFileSync } from 'node:fs';
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { pwaPlugin } from './src/pwa/vite-plugin.ts';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string };
// ビルドした時刻。画面と Service Worker（sw.js）の両方に埋め込み、新しい版が出たかを比べる（試験では DTXE_BUILD_TIME で決められる）
const BUILD_TIME = Number(process.env.DTXE_BUILD_TIME) || Date.now();

// GitHub Pages では https://check5004.github.io/dtx-mania-web-editor/ で配信される
export default defineConfig({
  base: '/dtx-mania-web-editor/',
  // pwaPlugin: ホーム画面に追加できるアプリにする（sw.js・iPad の起動画面。src/pwa/vite-plugin.ts）
  plugins: [react(), pwaPlugin({ version: pkg.version, build: BUILD_TIME })],
  define: {
    __DTXE_VERSION__: JSON.stringify(pkg.version),
    __DTXE_BUILD_TIME__: String(BUILD_TIME),
  },
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
