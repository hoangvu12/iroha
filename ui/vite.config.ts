import { fileURLToPath, URL } from 'node:url'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

/**
 * In development the UI runs on Vite and forwards API and health traffic to the
 * Elysia process. In production `bun run build` emits `ui/dist`, which the same
 * Elysia process serves directly.
 */
const IROHA_SERVER = process.env.IROHA_DEV_SERVER ?? 'http://127.0.0.1:3000'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
  server: {
    proxy: {
      '/api': { target: IROHA_SERVER, changeOrigin: true },
      '/health': { target: IROHA_SERVER, changeOrigin: true },
      '/providers': { target: IROHA_SERVER, changeOrigin: true },
    },
  },
})
