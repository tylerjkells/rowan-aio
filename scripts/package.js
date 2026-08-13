/**
 * Runs electron-builder with one automatic retry. Corporate antivirus
 * sometimes holds a handle on freshly written exes exactly when the builder
 * renames its temp folder (EPERM); a short wait and a retry always succeeds.
 *
 * With --test it packages the portable TEST flavor instead: portable target
 * only, its own appId, channel: "test" stamped into package.json (which
 * redirects its data to %APPDATA%\meeting-scribe-test and disables
 * self-update), and a distinct artifact name.
 */
const { spawnSync } = require('child_process')
const fs = require('fs')

const OUT = 'dist-installer'
const isTest = process.argv.includes('--test')

function cleanTemp() {
  for (const d of [`${OUT}/win-unpacked`, `${OUT}/win-unpacked.tmp`]) {
    try {
      fs.rmSync(d, { recursive: true, force: true })
    } catch {
      /* locked; the wait below usually frees it */
    }
  }
}

function run() {
  const args = ['electron-builder', '--win']
  if (isTest) args.push('portable')
  args.push(`-c.directories.output=${OUT}`)
  if (isTest) {
    args.push(
      '-c.extraMetadata.channel=test',
      '-c.appId=com.tylerkells.meetingscribe.test',
      '-c.portable.artifactName=MeetingScribe-Test-portable.exe'
    )
  }
  const r = spawnSync(process.platform === 'win32' ? 'npx.cmd' : 'npx', args, {
    stdio: 'inherit',
    shell: true
  })
  return r.status === 0
}

async function main() {
  const delays = [10000, 30000]
  if (run()) return 0
  for (const delay of delays) {
    console.log(`\npackaging failed (likely AV scan race); retrying in ${delay / 1000}s…\n`)
    cleanTemp()
    await new Promise((r) => setTimeout(r, delay))
    cleanTemp()
    if (run()) return 0
  }
  return 1
}

main().then((code) => process.exit(code))
