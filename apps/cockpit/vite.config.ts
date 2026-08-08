import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import tailwind from '@tailwindcss/vite'

// WikiKit serves this bundle itself, so the build lands in the directory the
// embedding generator packs into src/cockpit-embedded.ts. Nothing about the
// console needs a second process, a second deployment or a second version
// number.
const API_ORIGIN = process.env.WIKIKIT_DEV_ORIGIN || 'http://127.0.0.1:4060'

// The dev server has to look like the API origin to the browser: same origin so
// the session cookie applies and so the same-origin rule on cookie-authenticated
// writes is satisfied. Everything the console links to or calls is proxied
// through, including /review — the public proposal review page the cockpit
// hands out as a URL.
const proxy = Object.fromEntries(
  ['/v1', '/openapi.json', '/health', '/ready', '/llms.txt', '/review'].map((path) => [
    path,
    { target: API_ORIGIN, changeOrigin: true },
  ]),
)

/**
 * The contract marker, DERIVED rather than typed — CUI-MARK-1.
 *
 * Two meta tags in the served document: which contract this console implements,
 * and a digest of the token bytes it implements it with. The digest is computed
 * here, at build time, from `contract/cockpit-ui.css` — the same file the
 * offline contract test compares `index.css` against.
 *
 * Derived is the whole point. A hand-typed version number cannot notice that
 * the bytes underneath it changed; a digest can only agree when the bytes
 * agree. A console serving different colours announces a different string — in
 * the DOM, in every screenshot, without anybody having to run a comparison.
 */
function contractMeta(): Plugin {
  return {
    name: 'wikikit-cockpit-contract-meta',
    transformIndexHtml(html) {
      const css = readFileSync(fileURLToPath(new URL('../../contract/cockpit-ui.css', import.meta.url)), 'utf8')
      const digest = createHash('sha256').update(css).digest('hex').slice(0, 12)
      return html.replace(
        '</head>',
        `  <meta name="cockpit-ui-contract" content="cockpit-ui" />\n` +
          `    <meta name="cockpit-ui-digest" content="sha256-${digest}" />\n  </head>`,
      )
    },
  }
}

export default defineConfig({
  // Pinned to this file rather than left to the working directory: the build is
  // driven from the repository root (`bun run build:cockpit`) so that one
  // install and one lockfile cover the whole project, and a cwd-relative root
  // would look for index.html there.
  root: fileURLToPath(new URL('.', import.meta.url)),
  base: '/cockpit/',
  plugins: [react(), tailwind(), contractMeta()],
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  server: { port: 4061, proxy },
  build: {
    outDir: '../../assets/cockpit',
    emptyOutDir: true,
    target: 'es2022',
    // The bundle ships inside a binary an operator downloads, so its size is a
    // number somebody notices. Splitting the heavy, independently-cacheable
    // dependencies keeps the first paint out of their download path — and the
    // markdown renderer only loads on the pages that render a document.
    rollupOptions: {
      output: {
        manualChunks: (id: string) => {
          if (id.includes('node_modules/react-markdown') || id.includes('node_modules/remark')) return 'markdown'
          if (id.includes('node_modules/react') || id.includes('node_modules/scheduler')) return 'react'
          if (id.includes('node_modules/@tanstack')) return 'tanstack'
          return undefined
        },
      },
    },
  },
})
