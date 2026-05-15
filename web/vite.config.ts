import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'path'

export default defineConfig({
  root: path.resolve(__dirname),
  plugins: [react(), tailwindcss()],
  build: {
    outDir: path.resolve(__dirname, 'dist'),
    emptyOutDir: true,
    chunkSizeWarningLimit: 2200,
  },
  resolve: {
    alias: {
      '@desktop': path.resolve(__dirname, '..', 'desktop', 'src'),
      '@': path.resolve(__dirname, '..', 'desktop', 'src'),
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://127.0.0.1:3456',
      '/ws': { target: 'ws://127.0.0.1:3456', ws: true },
    },
  },
})
