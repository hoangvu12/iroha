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

export default defineConfig(({ command }) => ({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
  // The dev gateway URL is injected into the client bundle so the UI can
  // hand the Owner a runnable snippet (e.g. the Code Snippet card). In dev
  // the UI is served by Vite on a different origin than the gateway, so
  // `window.location.origin` would point at Vite and the resulting curl
  // would 404 — inference is intentionally not in the Vite proxy list
  // because real applications should hit the gateway directly. In
  // production Vite does not exist, the gateway serves the UI itself, and
  // `window.location.origin` is already the right answer, so the
  // constant is only defined when Vite is running the dev server.
  define: command === 'serve'
    ? { __IROHA_DEV_GATEWAY_URL__: JSON.stringify(IROHA_ORIGIN) }
    : {},
  server: {
    proxy: {
      '/api': proxyToIroha,
      '/health': proxyToIroha,
      '/logout': proxyToIroha,
      '/setup': proxyToIroha,
      '/docs': proxyToIroha,
    },
  },
}))