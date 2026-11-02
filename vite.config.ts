import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// GitHub Pages では https://check5004.github.io/dtx-mania-web-editor/ で配信される
export default defineConfig({
  base: '/dtx-mania-web-editor/',
  plugins: [react()],
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
