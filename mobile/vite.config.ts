import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'url'

// The phone app: a static site (out/mobile) that any static host can serve.
const root = fileURLToPath(new URL('.', import.meta.url))

/** production pages only talk to their own origin and the sync hub */
function csp(): Plugin {
  return {
    name: 'rowan-csp',
    apply: 'build',
    transformIndexHtml: (html) =>
      html.replace(
        '<meta charset="utf-8" />',
        `<meta charset="utf-8" />
    <meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self' https:; worker-src 'self'; base-uri 'self'; form-action 'none'" />`
      )
  }
}

export default defineConfig({
  root,
  base: './',
  plugins: [react(), csp()],
  build: {
    outDir: fileURLToPath(new URL('../out/mobile', import.meta.url)),
    emptyOutDir: true
  },
  server: { host: true, port: 5180 }
})
