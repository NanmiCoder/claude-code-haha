import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'path'

const webNodeModules = path.resolve(__dirname, 'node_modules')
const tauriStub = path.resolve(__dirname, 'src', 'tauri-stub.ts')

// All Tauri packages that desktop/src may import.
// Map each to our web stub so both dev scanning and production builds resolve cleanly.
const TAURI_PACKAGES = [
  '@tauri-apps/api/core',
  '@tauri-apps/api/event',
  '@tauri-apps/api/window',
  '@tauri-apps/api/app',
  '@tauri-apps/plugin-shell',
  '@tauri-apps/plugin-process',
  '@tauri-apps/plugin-notification',
  '@tauri-apps/plugin-updater',
  '@tauri-apps/plugin-dialog',
]

const tauriAlias = Object.fromEntries(
  TAURI_PACKAGES.map((pkg) => [pkg, tauriStub]),
)

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
  },
  resolve: {
    alias: {
      ...tauriAlias,
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
