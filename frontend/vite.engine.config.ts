import path from 'node:path'
import { defineConfig } from 'vite'

/**
 * Bundles the retirement engine (src/engine/server-entry.ts) into one script for the backend, which runs it
 * with an embedded JavaScript engine. Run `scripts/build-engine.sh` from the repo root after changing anything the
 * engine imports: it builds into `frontend/engine-dist` and copies the result to `backend/app/engine`. A frontend test
 * fails when the committed bundle is out of date, and a backend test when the copy does not match it.
 */
export default defineConfig({
  resolve: { alias: { '@': path.resolve(import.meta.dirname, 'src') } },
  build: {
    lib: { entry: path.resolve(import.meta.dirname, 'src/engine/server-entry.ts'), formats: ['iife'], name: 'RetirementEngine', fileName: () => 'retirement_engine.js' },
    outDir: path.resolve(import.meta.dirname, 'engine-dist'),
    emptyOutDir: false,
    minify: false,
    sourcemap: false,
    target: 'es2020',
    copyPublicDir: false,
  },
})
