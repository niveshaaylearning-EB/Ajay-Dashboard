import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const buildTs = Date.now();

export default defineConfig({
  base: '/wp/',
  plugins: [react()],
  server: {
    proxy: { '/api': 'http://localhost:8101' }
  },
  build: {
    rollupOptions: {
      output: {
        entryFileNames: `assets/[name]-[hash]-${buildTs}.js`,
        chunkFileNames: `assets/[name]-[hash]-${buildTs}.js`,
        assetFileNames: `assets/[name]-[hash]-${buildTs}.[ext]`,
      },
    },
  },
})
