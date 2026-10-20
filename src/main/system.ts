import {
  app,
  BrowserWindow,
  Menu,
  Tray,
  globalShortcut,
  nativeImage,
  powerSaveBlocker,
  shell,
  type MenuItemConstructorOptions,
  type NativeImage
} from 'electron'
import { execFile } from 'child_process'
import { channel } from './channel'
import { join } from 'path'
import { getSettings } from './settings'
import type { NavRequest, RecordingMode } from '../shared/types'

// ---------------------------------------------------------------------------
// Always-on plumbing: tray residency (close hides instead of quitting),
// launch at login (starting hidden), and a global Ctrl+Alt+R that brings the
// app forward on the Record page from anywhere.
// ---------------------------------------------------------------------------

let tray: Tray | null = null
let quitting = false

app.on('before-quit', () => {
  quitting = true
})

export function isQuitting(): boolean {
  return quitting
}

export function iconPath(): string {
  // packaged: build/icon.ico ships inside the asar; dev: repo path
  return join(app.getAppPath(), 'build', 'icon.ico')
}

function mainWindow(): BrowserWindow | null {
  return BrowserWindow.getAllWindows()[0] ?? null
}

/** index.ts hands us its window creator so show paths can recover from a missing window */
let windowFactory: (() => BrowserWindow) | null = null
export function registerWindowFactory(factory: () => BrowserWindow): void {
  windowFactory = factory
}

/**
 * Bring the app forward, whatever state it is in. After hours hidden in the
 * tray the renderer process can be gone (crashed or killed by the OS) — naively
 * showing that window presents an empty shell, so reload it; and if the window
 * itself is gone, make a new one.
 */
export function showMainWindow(): BrowserWindow | null {
  let win = mainWindow()
  if (!win || win.isDestroyed()) {
    if (!windowFactory) return null
    win = windowFactory()
  } else if (win.webContents.isCrashed()) {
    win.webContents.reload()
  }
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
  return win
}

// ---- navigation from outside the window ----
// Links, the tray, notifications, and the hotkey all land here. The request
// waits in pendingNav until the renderer takes it, so a window that is still
// loading (or reloading after a crash) cannot miss it, and it is delivered
// exactly once. The nudge to take it goes in as a simulated user gesture:
// starting a recording opens system-audio capture, which Chromium only allows
// right after a click.
let pendingNav: NavRequest | null = null

export function navigate(req: NavRequest): void {
  pendingNav = req
  const win = showMainWindow()
  if (win) deliverNav(win, 0)
}

function deliverNav(win: BrowserWindow, attempt: number): void {
  if (!pendingNav || win.isDestroyed()) return
  const wc = win.webContents
  if (wc.isLoading()) {
    wc.once('did-finish-load', () => setTimeout(() => deliverNav(win, attempt), 300))
    return
  }
  wc.executeJavaScript("window.dispatchEvent(new Event('rowan-nav'))", true).catch(() => {})
  // the page may not be listening yet right after a load; keep knocking briefly
  if (attempt < 12) setTimeout(() => deliverNav(win, attempt + 1), 600)
}

/**
 * The renderer collecting its navigation. A start-recording request is only
 * handed over on the gesture path, so capture is allowed to open.
 */
export function takePendingNav(gesture: boolean): NavRequest | null {
  if (!pendingNav || (pendingNav.autostart && !gesture)) return null
  const req = pendingNav
  pendingNav = null
  return req
}

/** open a meeting's call link and start recording it (tray, notifications) */
export function joinAndRecord(joinUrl: string | null, mode: RecordingMode = 'virtual'): void {
  if (joinUrl && /^https?:\/\//i.test(joinUrl)) shell.openExternal(joinUrl).catch(() => {})
  navigate({ view: { name: 'record' }, autostart: mode })
}

// ---- tray ----
// The tray says what is going on without opening the window: a red dot while
// recording, the next meeting on hover, and today's remaining meetings in the
// menu (one click joins the call and starts recording).

export interface TrayInfo {
  recording: { since: number; title: string | null } | null
  upcoming: { title: string; start: string; joinUrl: string | null; location: string | null }[]
}

let trayInfo: TrayInfo = { recording: null, upcoming: [] }
let baseIcon: NativeImage | null = null
let recIcon: NativeImage | null = null

export function setTrayInfo(info: TrayInfo): void {
  trayInfo = info
  refreshTray()
}

/** the app icon with a red recording dot in the corner */
function recordingIcon(base: NativeImage): NativeImage {
  const size = 32
  const bitmap = Buffer.from(base.resize({ width: size, height: size, quality: 'best' }).toBitmap())
  if (bitmap.length < size * size * 4) return base
  const cx = 23.5
  const cy = 23.5
  const r = 7
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy)
      if (d > r + 1.5) continue
      const i = (y * size + x) * 4
      // BGRA: a white ring around a red dot
      const [b, g, rr] = d > r ? [255, 255, 255] : [0x3d, 0x3d, 0xe5]
      bitmap[i] = b
      bitmap[i + 1] = g
      bitmap[i + 2] = rr
      bitmap[i + 3] = 255
    }
  }
  return nativeImage.createFromBitmap(bitmap, { width: size, height: size })
}

function clock(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
}

function untilText(iso: string): string {
  const mins = Math.round((new Date(iso).getTime() - Date.now()) / 60000)
  if (mins <= 0) return 'now'
  if (mins < 60) return `in ${mins} min`
  return `at ${clock(iso)}`
}

function refreshTray(): void {
  if (!tray) return
  const { recording, upcoming } = trayInfo
  try {
    if (!baseIcon) baseIcon = nativeImage.createFromPath(iconPath())
    if (recording && !recIcon) recIcon = recordingIcon(baseIcon)
    tray.setImage(recording && recIcon ? recIcon : baseIcon)
  } catch {
    // keep whatever icon is showing
  }

  const elapsed = recording ? Math.max(0, Math.round((Date.now() - recording.since) / 60000)) : 0
  const next = upcoming[0]
  // Windows caps tray tooltips at 127 characters
  const tip = recording
    ? `Rowan AIO · Recording${recording.title ? ` ${recording.title}` : ''} · ${elapsed} min`
    : next
      ? `Rowan AIO · Next: ${next.title} ${untilText(next.start)}`
      : 'Rowan AIO'
  tray.setToolTip(tip.length > 127 ? tip.slice(0, 126) + '…' : tip)

  const items: MenuItemConstructorOptions[] = []
  if (recording) {
    items.push(
      {
        label: `Recording${recording.title ? `: ${recording.title}` : ''} · ${elapsed} min`,
        enabled: false
      },
      { label: 'Show the recording', click: () => navigate({ view: { name: 'record' } }) }
    )
  } else {
    items.push({ label: 'Start recording', click: () => navigate({ view: { name: 'record' } }) })
  }
  items.push({ label: 'Open Rowan AIO', click: () => showMainWindow() })
  if (upcoming.length > 0) {
    items.push({ type: 'separator' }, { label: 'Coming up today', enabled: false })
    for (const e of upcoming.slice(0, 4)) {
      const label = `${clock(e.start)}  ${e.title.length > 48 ? e.title.slice(0, 47) + '…' : e.title}`
      items.push(
        e.joinUrl && !recording
          ? { label: `${label}  · join & record`, click: () => joinAndRecord(e.joinUrl) }
          : { label, click: () => navigate({ view: { name: 'today' } }) }
      )
    }
  }
  items.push(
    { type: 'separator' },
    {
      label: 'Quit',
      click: () => {
        quitting = true
        app.quit()
      }
    }
  )
  tray.setContextMenu(Menu.buildFromTemplate(items))
}

function ensureTray(): void {
  if (tray) return
  const image = nativeImage.createFromPath(iconPath())
  tray = new Tray(image)
  tray.on('click', () => showMainWindow())
  refreshTray()
}

function destroyTray(): void {
  tray?.destroy()
  tray = null
}

// ---- keep awake ----
// A synthetic 1px mouse move (SendInput) resets the OS idle timer, which is
// what Windows lock timers and Teams presence watch — powerSaveBlocker alone
// keeps the display on but still lets you go "Away". Ticks are randomized
// (60–150s) and can follow a daily schedule with a break window.
let jiggleTimer: NodeJS.Timeout | null = null
let sleepBlockerId: number | null = null

const JIGGLE_PS = `
Add-Type @'
using System;
using System.Runtime.InteropServices;
public class Jiggler {
  [StructLayout(LayoutKind.Sequential)]
  public struct INPUT { public uint type; public MOUSEINPUT mi; }
  [StructLayout(LayoutKind.Sequential)]
  public struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [DllImport("user32.dll", SetLastError=true)]
  public static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);
  public static void Jiggle() {
    INPUT[] moves = new INPUT[2];
    moves[0].type = 0; moves[0].mi.dx = 1;  moves[0].mi.dy = 0; moves[0].mi.dwFlags = 0x0001;
    moves[1].type = 0; moves[1].mi.dx = -1; moves[1].mi.dy = 0; moves[1].mi.dwFlags = 0x0001;
    SendInput(2, moves, Marshal.SizeOf(typeof(INPUT)));
  }
}
'@
[Jiggler]::Jiggle()
`

function jiggleOnce(): void {
  if (process.platform !== 'win32') return
  execFile(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', JIGGLE_PS],
    { windowsHide: true },
    () => {}
  )
}

function minutesOf(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number)
  return (h || 0) * 60 + (m || 0)
}

function inKeepAwakeWindow(): boolean {
  const s = getSettings()
  if (!s.keepAwakeScheduled) return true
  const now = new Date()
  const cur = now.getHours() * 60 + now.getMinutes()
  const start = minutesOf(s.keepAwakeStart)
  const end = minutesOf(s.keepAwakeEnd)
  const breakStart = minutesOf(s.keepAwakeBreakStart)
  const breakEnd = minutesOf(s.keepAwakeBreakEnd)
  const working = start <= cur && cur < end
  const onBreak = breakStart < breakEnd && breakStart <= cur && cur < breakEnd
  return working && !onBreak
}

function scheduleNextJiggle(): void {
  const delay = 60_000 + Math.random() * 90_000
  jiggleTimer = setTimeout(() => {
    if (inKeepAwakeWindow()) jiggleOnce()
    scheduleNextJiggle()
  }, delay)
}

function setKeepAwake(on: boolean): void {
  if (on && !jiggleTimer) {
    if (inKeepAwakeWindow()) jiggleOnce()
    scheduleNextJiggle()
    if (sleepBlockerId === null) sleepBlockerId = powerSaveBlocker.start('prevent-display-sleep')
  } else if (!on && jiggleTimer) {
    clearTimeout(jiggleTimer)
    jiggleTimer = null
    if (sleepBlockerId !== null && powerSaveBlocker.isStarted(sleepBlockerId)) {
      powerSaveBlocker.stop(sleepBlockerId)
    }
    sleepBlockerId = null
  }
}

/** (Re)apply tray, login item, hotkey, and keep-awake to match settings. Safe to call often. */
export function applySystemSettings(): void {
  const s = getSettings()

  if (s.closeToTray) ensureTray()
  else destroyTray()

  setKeepAwake(s.keepAwake)

  if (channel === 'stable') {
    // neither the dev electron.exe nor a portable test build may register
    // itself as a login item
    app.setLoginItemSettings({
      openAtLogin: s.launchAtLogin,
      args: ['--hidden']
    })
  }

  globalShortcut.unregister('Control+Alt+R')
  if (s.recordHotkey) {
    globalShortcut.register('Control+Alt+R', () => navigate({ view: { name: 'record' } }))
  }
}

/** windows launched with --hidden (login start) stay in the tray */
export function startHidden(): boolean {
  return process.argv.includes('--hidden')
}
