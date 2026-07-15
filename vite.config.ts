import { appendFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

// Dev-only bridge for src/dev/suggest.ts (point-and-suggest overlay): receives
// "change this element" notes from the running app and appends them to
// design-notes.jsonl at the repo root, where a coding agent picks them up.
// `apply: 'serve'` keeps it out of production builds entirely.
function suggestBridge(): Plugin {
  return {
    name: 'nocturne-suggest-bridge',
    apply: 'serve',
    configureServer(server) {
      const notesFile = resolve(server.config.root, 'design-notes.jsonl')
      server.middlewares.use('/__suggest', (req, res) => {
        if (req.method !== 'POST') {
          res.statusCode = 405
          res.end()
          return
        }
        const chunks: Buffer[] = []
        req.on('data', (c) => chunks.push(c))
        req.on('end', () => {
          try {
            const entry = JSON.parse(Buffer.concat(chunks).toString('utf8'))
            appendFileSync(notesFile, JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n')
            res.statusCode = 204
          } catch {
            res.statusCode = 400
          }
          res.end()
        })
      })
    },
  }
}

// Nocturne ships as an installable, offline-capable PWA — the point is to read
// on your phone without a live connection. The service worker precaches the app
// shell; PDFs live in IndexedDB (see src/storage/db.ts), never on a server.
export default defineConfig({
  plugins: [
    suggestBridge(),
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.svg'],
      manifest: {
        name: 'Nocturne',
        short_name: 'Nocturne',
        description: 'Night-reading environment for PDFs you own.',
        theme_color: '#15110b',
        background_color: '#15110b',
        display: 'standalone',
        orientation: 'portrait',
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        // pdf.js worker + wasm can be large; lift the precache size ceiling.
        maximumFileSizeToCacheInBytes: 6 * 1024 * 1024,
        // The dictionary is ~9.5MB of shards; precaching it would balloon every
        // install for a feature many sessions never touch. Fetch on first
        // lookup, then cache-first so definitions keep working offline.
        globIgnores: ['**/dict/**'],
        runtimeCaching: [
          {
            urlPattern: ({ url }) => url.pathname.includes('/dict/en/'),
            handler: 'CacheFirst',
            options: {
              cacheName: 'nocturne-dict',
              expiration: { maxEntries: 40 },
            },
          },
        ],
      },
    }),
  ],
  worker: { format: 'es' },
})
