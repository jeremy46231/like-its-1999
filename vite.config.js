import { resolve } from 'node:path'
import { defineConfig } from 'vite'

export default defineConfig({
  server: {
    // v86 fetches disk chunks with HTTP Range requests; Vite's static server handles these.
    fs: { allow: ['.'] },
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
