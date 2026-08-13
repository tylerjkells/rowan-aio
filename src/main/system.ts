import { app, BrowserWindow, Menu, Tray, globalShortcut, nativeImage } from 'electron'
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

function iconPath(): string {
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
  tray.setToolTip('MeetingScribe')
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Open MeetingScribe', click: () => showMainWindow() },
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

/** (Re)apply tray, login item, and hotkey to match settings. Safe to call often. */
export function applySystemSettings(): void {
  const s = getSettings()

  if (s.closeToTray) ensureTray()
  else destroyTray()

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
