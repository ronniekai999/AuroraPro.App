import path from "path"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"
import { inspectAttr } from 'kimi-plugin-inspect-react'

// Aurora V2 build configuration.
//
// `base: '/v2/'` makes Vite emit asset URLs prefixed with /v2/, so the
// browser fetches /v2/assets/index-XXXX.js when Aurora's Go server serves
// the SPA at that path. Without this, Vite would emit absolute /assets/
// URLs that would 404 (those live under /v2/assets/ from Go's POV).
//
// `outDir: '../../v2'` writes the production bundle directly into
// static/v2/, which Go's safeFileServer picks up via the existing
// /static/ mount and the new /v2/* route in router.go.
//
// `emptyOutDir: true` is critical: each rebuild wipes static/v2/ so
// stale chunks from a previous build don't accumulate. Vite refuses to
// empty a directory outside the project root by default, so we set
// this explicitly.
export default defineConfig({
  base: '/v2/',
  plugins: [inspectAttr(), react()],
  server: {
    port: 3000,
    proxy: {
      // Dev-server convenience: when running `npm run dev` against the
      // Aurora backend at :8484, proxy API/WS calls so V2 can hit them
      // without CORS. Production serves V2 from Aurora directly so this
      // is a no-op there.
      '/api': 'http://localhost:8484',
      '/ws': { target: 'ws://localhost:8484', ws: true },
    },
  },
  build: {
    outDir: '../../v2',
    emptyOutDir: true,
    sourcemap: false,
    // Bundle assertion budget. R3F + three + GSAP is heavy; we don't
    // want to silently grow forever. 2 MB is plenty for a single
    // initial chunk.
    chunkSizeWarningLimit: 2048,
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
