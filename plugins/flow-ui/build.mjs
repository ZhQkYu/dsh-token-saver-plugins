/**
 * Bundle the flow-ui client half into lib/client.js, wrapping the esbuild CJS
 * output in the browser ModuleLoader protocol. Externals are the platform
 * modules the Web runtime already provides (react, cordis, client UI
 * primitives); everything else (e.g. @xyflow/react) is bundled in.
 */
import { build } from 'esbuild'
import fs from 'node:fs'

const result = await build({
  entryPoints: ['src/client/index.tsx'],
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  jsx: 'automatic',
  loader: { '.css': 'text' },
  external: [
    'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client',
    '@deepseek-ai/cordis',
    '@deepseek-ai/dsh-client-ui-primitives',
  ],
  write: false,
  sourcemap: 'inline',
})

const code = result.outputFiles[0].text
const wrapped = `window.__ModuleLoader__.load({
  id: '@dsh-plugins/flow-ui',
  factory(require) {
    const module = { exports: {} }
    const exports = module.exports
    ;(function (module, exports, require) {
${code}
    })(module, exports, require)
    return module.exports
  },
})
`
fs.mkdirSync('lib', { recursive: true })
fs.writeFileSync('lib/client.js', wrapped)
console.log('wrote lib/client.js')
