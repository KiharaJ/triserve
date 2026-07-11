import path from 'node:path'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  // @triserve/shared is a CommonJS workspace package (module: NodeNext, no
  // "type":"module") consumed as CJS by the NestJS API. Vite skips linked
  // workspace deps during dep-optimization by default, so its dev server sees
  // the raw CJS `__exportStar` re-export and can't statically resolve named
  // exports like `roleHasPermission` — the app fails to mount (blank page).
  // Forcing it into optimizeDeps makes esbuild pre-bundle it to ESM with
  // detectable named exports. (The production Rollup build handles this on its
  // own, which is why `vite build` worked but dev did not.)
  optimizeDeps: {
    include: ['@triserve/shared'],
  },
  server: {
    // Bind to all interfaces so the dev app is reachable from other devices on
    // the LAN (e.g. a phone at http://<mac-lan-ip>:5173). API calls stay
    // relative (/api/v1) and are proxied server-side to :3000 below, so this
    // needs no CORS or API-URL change.
    host: true,
    proxy: {
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true,
      },
    },
  },
})
