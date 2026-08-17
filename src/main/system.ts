import { app, BrowserWindow, Menu, Tray, globalShortcut, nativeImage, powerSaveBlocker } from 'electron'
import { execFile } from 'child_process'
import { channel } from './channel'
import { join } from 'path'
import { getSettings } from './settings'

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
export function showMainWindow(page?: 'record'): void {
  let win = mainWindow()
  if (!win || win.isDestroyed()) {
    if (!windowFactory) return
    win = windowFactory()
  } else if (win.webContents.isCrashed()) {
    win.webContents.reload()
  }
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
  if (page === 'record') {
    const wc = win.webContents
    if (wc.isLoading()) wc.once('did-finish-load', () => wc.send('nudge:openRecord'))
    else wc.send('nudge:openRecord')
  }
}

function ensureTray(): void {
  if (tray) return
  const image = nativeImage.createFromPath(iconPath())
  tray = new Tray(image)
  tray.setToolTip('Rowan AIO')
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Open Rowan AIO', click: () => showMainWindow() },
      { label: 'Start recording', click: () => showMainWindow('record') },
      { type: 'separator' },
      {
        label: 'Quit',
        click: () => {
          quitting = true
          app.quit()
        }
      }
    ])
  )
  tray.on('click', () => showMainWindow())
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
    globalShortcut.register('Control+Alt+R', () => showMainWindow('record'))
  }
}

/** windows launched with --hidden (login start) stay in the tray */
export function startHidden(): boolean {
  return process.argv.includes('--hidden')
}
