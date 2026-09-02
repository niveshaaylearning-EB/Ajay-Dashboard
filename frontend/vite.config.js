import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    host: true,        // listen on 0.0.0.0 so LAN devices can reach the dev server
    port: 5173,
    proxy: {
      // In dev, forward /api and /auth to the FastAPI backend
      '/api':  { target: 'http://localhost:8100', changeOrigin: true },
      '/auth': { target: 'http://localhost:8100', changeOrigin: true },
    },
  },
  preview: {
    host: true,
    port: 4173,
  },
})
