import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'path'

const webNodeModules = path.resolve(__dirname, 'node_modules')

export default defineConfig({
  root: path.resolve(__dirname),
  plugins: [
    react(),
    tailwindcss(),
    {
      name: 'resolve-from-web-node_modules',
      resolveId(id, importer) {
        if (!importer) return null
        if (id.startsWith('.') || id.startsWith('@desktop') || id.startsWith('@/')) return null
        if (id.startsWith('@tauri-apps/')) return null
        // Try to resolve from web/node_modules
        try {
          return this.resolve(id, webNodeModules, { skipSelf: true })
        } catch {
          return null
        }
      },
    },
  ],
  build: {
    outDir: path.resolve(__dirname, 'dist'),
    emptyOutDir: true,
    chunkSizeWarningLimit: 2200,
    rollupOptions: {
      external: (id: string) => id.startsWith('@tauri-apps/'),
    },
  },
  resolve: {
    alias: {
      '@desktop': path.resolve(__dirname, '..', 'desktop', 'src'),
      '@': path.resolve(__dirname, '..', 'desktop', 'src'),
      'lucide-react': path.resolve(__dirname, 'node_modules/lucide-react'),
      'zustand': path.resolve(__dirname, 'node_modules/zustand'),
      'react': path.resolve(__dirname, 'node_modules/react'),
      'react-dom': path.resolve(__dirname, 'node_modules/react-dom'),
      'react/jsx-runtime': path.resolve(__dirname, 'node_modules/react/jsx-runtime'),
      'react/jsx-dev-runtime': path.resolve(__dirname, 'node_modules/react/jsx-dev-runtime'),
    },
    modules: [path.resolve(__dirname, 'node_modules'), 'node_modules'],
  },
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://127.0.0.1:3456',
      '/ws': { target: 'ws://127.0.0.1:3456', ws: true },
    },
  },
})
