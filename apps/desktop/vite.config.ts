import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Tauri 开发服务器约定：固定端口 1420；移动端调试时由 TAURI_DEV_HOST 指定地址。
const host = process.env.TAURI_DEV_HOST;

export default defineConfig({
  plugins: [react(), tailwindcss()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: 'ws', host, port: 1421 } : undefined,
    watch: { ignored: ['**/src-tauri/**'] },
  },
  envPrefix: ['VITE_', 'TAURI_ENV_*'],
  build: {
    // macOS 13 自带 Safari 16 的 WebKit
    target: 'safari16',
    sourcemap: !!process.env.TAURI_ENV_DEBUG,
  },
});
