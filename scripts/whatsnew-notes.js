// Prints the What's New bullets for a given version as markdown, for use as
// the GitHub release body. Reads the NOTES map out of WhatsNew.tsx with a
// regex rather than importing it (the file is TSX). Prints nothing (exit 0)
// when the version has no entry, so the release falls back to auto-generated
// notes alone.
const fs = require('fs')
const path = require('path')

const version = process.argv[2]
if (!version) {
  console.error('usage: node scripts/whatsnew-notes.js <version>')
  process.exit(1)
}

const src = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'renderer', 'src', 'WhatsNew.tsx'),
  'utf8'
)

const entry = src.match(new RegExp(`'${version.replace(/\./g, '\\.')}':\\s*\\[([\\s\\S]*?)\\]`))
if (!entry) process.exit(0)

// each bullet is a single-quoted JS string; unescape \' and drop the quotes
const bullets = [...entry[1].matchAll(/'((?:[^'\\]|\\.)*)'/g)].map((m) =>
  m[1].replace(/\\(['\\])/g, '$1')
)
if (bullets.length === 0) process.exit(0)

console.log(bullets.map((b) => `- ${b}`).join('\n'))
