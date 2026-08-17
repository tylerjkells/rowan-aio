import { app } from 'electron'
import { spawn } from 'child_process'
import { existsSync, readdirSync, rmSync, statSync } from 'fs'
import { join } from 'path'
import { getSettings, getLastBackupAt, setLastBackupAt } from './settings'

// ---------------------------------------------------------------------------
// Library backup: zip the meetings folder (plus settings and Ask history)
// using the bsdtar that ships with Windows — the same tool the engine
// download already relies on. Manual "back up now", plus a weekly automatic
// backup into a chosen folder with old archives pruned.
// ---------------------------------------------------------------------------

const WEEK_MS = 7 * 24 * 60 * 60 * 1000
const KEEP_AUTO_BACKUPS = 8
const AUTO_PREFIX = 'RowanAIO-backup-'

export interface BackupResult {
  path: string
  bytes: number
}

export async function runBackup(destZip: string, skipAudio: boolean): Promise<BackupResult> {
  const userData = app.getPath('userData')
  const targets = [
    'meetings',
    'settings.json',
    'ask.json',
    'directory.json',
    'links.json',
    'link-thumbs',
    'brand.json',
    'toolbox',
    'prep.json'
  ].filter((t) =>
    existsSync(join(userData, t))
  )
  if (!targets.includes('meetings')) {
    throw new Error('Nothing to back up yet — the library is empty.')
  }

  const args = ['-a', '-c', '-f', destZip, '-C', userData]
  if (skipAudio) {
    // audio dwarfs everything else; notes stay tiny and searchable
    args.push('--exclude', '*.webm', '--exclude', '*audio.wav')
  }
  args.push(...targets)

  const tar = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe')
  await new Promise<void>((resolve, reject) => {
    const p = spawn(tar, args, { windowsHide: true })
    let err = ''
    p.stderr.on('data', (d) => (err += d))
    p.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`Backup failed: ${err.slice(-400) || `tar exited ${code}`}`))
    )
    p.on('error', reject)
  })

  return { path: destZip, bytes: statSync(destZip).size }
}

function autoBackupName(): string {
  const d = new Date()
  const stamp = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  return `${AUTO_PREFIX}${stamp}.zip`
}

/** delete the oldest automatic backups beyond the keep limit */
function prune(folder: string): void {
  try {
    const backups = readdirSync(folder)
      .filter((f) => f.startsWith(AUTO_PREFIX) && f.endsWith('.zip'))
      .sort()
    for (const f of backups.slice(0, Math.max(0, backups.length - KEEP_AUTO_BACKUPS))) {
      rmSync(join(folder, f), { force: true })
    }
  } catch {
    // pruning is best-effort
  }
}

async function tick(): Promise<void> {
  const s = getSettings()
  if (!s.backupFolder || !existsSync(s.backupFolder)) return
  if (Date.now() - getLastBackupAt() < WEEK_MS) return
  try {
    await runBackup(join(s.backupFolder, autoBackupName()), s.backupSkipAudio)
    setLastBackupAt(Date.now())
    prune(s.backupFolder)
  } catch {
    // failed run retries on the next tick
  }
}

/** check shortly after launch, then daily while running */
export function startAutoBackup(): void {
  setTimeout(() => tick().catch(() => 0), 90_000)
  setInterval(() => tick().catch(() => 0), 24 * 60 * 60 * 1000)
}
