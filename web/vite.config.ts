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
    // Forward API calls to the NestJS backend in dev, so the default
    // VITE_API_BASE_URL=/api/v1 works without CORS setup.
    proxy: {
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true,
      },
    },
  },
})
