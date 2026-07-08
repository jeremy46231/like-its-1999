import { resolve } from 'node:path'
import { defineConfig } from 'vite'

export default defineConfig({
  server: {
    // v86 fetches disk chunks with HTTP Range requests; Vite's static server handles these.
    fs: { allow: ['.'] },
    // HMR disabled on purpose: a hot-reload wipes the emulator's in-memory disk
    // overlay + RAM (all unsaved VM work). Changes to served files now apply only
    // on a MANUAL reload, so an accidental edit can't nuke a live session.
    hmr: false,
  },
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        emulator: resolve(__dirname, 'emulator/index.html'),
      },
    },
  },
  // v86 ships a large wasm binary; don't inline it.
  assetsInclude: ['**/*.bin'],
})
