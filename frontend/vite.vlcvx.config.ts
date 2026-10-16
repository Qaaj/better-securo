import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import path from 'node:path'
import { defineConfig } from 'vite'

/**
 * Builds the vlCVX tab as a site of its own (`npm run build:vlcvx` -> `vlcvx-dist/`). The page and components are
 * Securo's own; only what talks to Securo is swapped: the API client for one that reads static JSON, and the
 * workspace context for a read-only stub.
 */
const here = import.meta.dirname
export default defineConfig({
  root: path.resolve(here, 'standalone/vlcvx'),
  base: '/',
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: [
      { find: /^@\/lib\/api$/, replacement: path.resolve(here, 'standalone/vlcvx/static-api.ts') },
      { find: /^@\/contexts\/workspace-context$/, replacement: path.resolve(here, 'standalone/vlcvx/workspace-context.ts') },
      { find: '@', replacement: path.resolve(here, 'src') },
    ],
  },
  build: { outDir: path.resolve(here, 'vlcvx-dist'), emptyOutDir: true, chunkSizeWarningLimit: 1200 },
})
