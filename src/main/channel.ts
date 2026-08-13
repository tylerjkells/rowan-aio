import { app } from 'electron'
import { readFileSync } from 'fs'
import { join } from 'path'

export type Channel = 'stable' | 'test' | 'dev'

function detect(): Channel {
  if (!app.isPackaged) return 'dev'
  try {
    // test builds carry channel: "test" in their package.json, stamped by
    // `npm run dist:test` / the Test Build workflow via extraMetadata
    const pkg = JSON.parse(readFileSync(join(app.getAppPath(), 'package.json'), 'utf8'))
    if (pkg.channel === 'test') return 'test'
  } catch {
    // unreadable own package.json: treat as stable
  }
  return 'stable'
}

/**
 * Which flavor of the app this process is: the installed release ('stable'),
 * a portable test build ('test'), or `npm run dev` ('dev').
 */
export const channel: Channel = detect()

// Dev runs and test builds get their own data folder so they can never touch
// the real library; only the stable channel lives in %APPDATA%\meeting-scribe.
// This must happen before anything resolves app.getPath('userData'), so it
// runs at import time and index.ts imports this module first.
if (channel !== 'stable') {
  app.setPath('userData', join(app.getPath('appData'), `meeting-scribe-${channel}`))
}
