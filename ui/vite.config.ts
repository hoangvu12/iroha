import type { ProxyOptions } from 'vite'
import { fileURLToPath, URL } from 'node:url'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

/**
 * In development the UI runs on Vite and forwards API and health traffic to the
 * Elysia process. In production `bun run build` emits `ui/dist`, which the same
 * Elysia process serves directly.
 *
 * `changeOrigin: true` rewrites `Host` to the target, but Iroha's same-origin
 * guard compares `Origin` against `Host`. We rewrite `Origin` manually via
 * `configure` so a request proxied from `localhost:5173` looks like it came
 * from the dev server.
 */
const IROHA_SERVER = process.env.IROHA_DEV_SERVER ?? 'http://127.0.0.1:3000'
const IROHA_ORIGIN = new URL(IROHA_SERVER).origin

const proxyToIroha: ProxyOptions = {
  target: IROHA_SERVER,
  changeOrigin: true,
  configure(proxy) {
    proxy.on('proxyReq', (proxyReq) => {
      proxyReq.setHeader('origin', IROHA_ORIGIN)
    })
  },
}

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
      '/api': proxyToIroha,
      '/health': proxyToIroha,
      '/providers': proxyToIroha,
      '/logout': proxyToIroha,
      '/setup': proxyToIroha,
    },
  },
})