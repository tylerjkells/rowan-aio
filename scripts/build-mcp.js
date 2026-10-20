/**
 * Bundle the scripts the MeetingScribe executable runs in Node mode
 * (ELECTRON_RUN_AS_NODE=1), each into a single dependency-free CJS file:
 * the MCP server for Claude Desktop, and the voice identification worker.
 */
const { buildSync } = require('esbuild')

for (const [entry, outfile] of [
  ['src/mcp/server.ts', 'out/mcp/server.cjs'],
  ['src/voice/worker.ts', 'out/voice/worker.cjs']
]) {
  buildSync({
    entryPoints: [entry],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    outfile,
    logLevel: 'info'
  })
}
