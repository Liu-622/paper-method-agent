import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'node:path'

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  base: './',
  resolve: {
    alias: {
      '@': path.resolve(process.cwd(), 'src'),
    },
  },
  server: {
    port: 5173,
    host: '127.0.0.1',
    proxy: {
      // 开发时把 /api 转发到后端（node server/index.mjs）
      '/api': {
        target: process.env.API_PROXY_TARGET || 'http://127.0.0.1:8787',
        changeOrigin: true,
      },
    },
  },
  // pdfjs 的 worker 体积较大，单独分包，避免拖慢首屏
  optimizeDeps: {
    exclude: ['pdfjs-dist'],
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
  },
})
