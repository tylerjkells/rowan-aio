/**
 * Run the unit tests: bundle each tests/*.test.ts with esbuild (as the MCP
 * server is bundled) and hand them to Node's built-in test runner.
 */
const { buildSync } = require('esbuild')
const { readdirSync } = require('fs')
const { join } = require('path')
const { spawnSync } = require('child_process')

const outdir = join('out', 'tests')
const entries = readdirSync('tests')
  .filter((f) => f.endsWith('.test.ts'))
  .map((f) => join('tests', f))

buildSync({
  entryPoints: entries,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  outdir,
  outExtension: { '.js': '.cjs' },
  logLevel: 'warning'
})

const files = entries.map((e) => join(outdir, e.replace(/^tests[\\/]/, '').replace(/\.ts$/, '.cjs')))
const res = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit' })
process.exit(res.status ?? 1)
