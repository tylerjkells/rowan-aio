import { app } from 'electron'
import { execFileSync } from 'child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { URL_SCHEME } from './deeplink'

// ---------------------------------------------------------------------------
// Claude Desktop connection: install the bundled MCP server (a single
// dependency-free .cjs run by the MeetingScribe executable in Node mode) and
// register it in Claude Desktop's config. Read-only access to the library;
// nothing leaves the machine except in conversations the user has with
// Claude.
// ---------------------------------------------------------------------------

const ENTRY_NAME = 'meetingscribe'

function bundledServerPath(): string {
  // inside the asar in production; plain file in dev (built by scripts/build-mcp.js)
  return join(app.getAppPath(), 'out', 'mcp', 'server.cjs')
}

function installedServerPath(): string {
  return join(app.getPath('userData'), 'mcp', 'server.cjs')
}

function claudeDir(): string {
  return join(app.getPath('appData'), 'Claude')
}

function claudeConfigPath(): string {
  return join(claudeDir(), 'claude_desktop_config.json')
}

export interface ClaudeConnection {
  /** Claude Desktop appears to be installed on this machine */
  claudeFound: boolean
  /** our entry is present in its config */
  configured: boolean
  /**
   * Claude Desktop is currently running. It owns its config file and
   * rewrites it from memory, so edits made while it runs get clobbered —
   * the connect flow must happen while it is fully quit.
   */
  claudeRunning: boolean
}

function claudeIsRunning(): boolean {
  if (process.platform !== 'win32') return false
  try {
    const out = execFileSync('tasklist', ['/FI', 'IMAGENAME eq Claude.exe', '/NH'], {
      encoding: 'utf-8',
      windowsHide: true
    })
    return /claude\.exe/i.test(out)
  } catch {
    return false
  }
}

export function claudeConnectionStatus(): ClaudeConnection {
  const claudeFound = existsSync(claudeDir())
  let configured = false
  try {
    const config = JSON.parse(readFileSync(claudeConfigPath(), 'utf-8')) as {
      mcpServers?: Record<string, unknown>
    }
    configured = !!config.mcpServers?.[ENTRY_NAME]
  } catch {
    // missing or unreadable config: not configured
  }
  return { claudeFound, configured, claudeRunning: claudeIsRunning() }
}

/**
 * The server runs from a copy made at connect time, so an app update would
 * otherwise never reach it. When connected, keep that copy in step with the
 * bundled one (Node reads the file once at start, so swapping it is safe even
 * while Claude Desktop has the old one running).
 */
export function refreshClaudeServer(): void {
  try {
    if (!existsSync(installedServerPath()) || !existsSync(bundledServerPath())) return
    const bundled = readFileSync(bundledServerPath())
    if (!bundled.equals(readFileSync(installedServerPath()))) {
      writeFileSync(installedServerPath(), bundled)
    }
  } catch {
    // the old copy keeps working; reconnecting refreshes it too
  }
}

export function connectClaude(): ClaudeConnection {
  if (!existsSync(claudeDir())) {
    throw new Error(
      'Claude Desktop does not appear to be installed (no Claude folder in AppData). Install it from claude.ai/download first.'
    )
  }
  if (claudeIsRunning()) {
    throw new Error(
      'Quit Claude Desktop first (tray icon → Quit) — it rewrites its config file on exit and would erase this connection. Then connect here, then start Claude Desktop.'
    )
  }
  if (!existsSync(bundledServerPath())) {
    throw new Error('The MCP server bundle is missing from this build (out/mcp/server.cjs).')
  }

  // extract the server outside the asar so Node can execute it directly
  mkdirSync(join(app.getPath('userData'), 'mcp'), { recursive: true })
  writeFileSync(installedServerPath(), readFileSync(bundledServerPath()))

  let config: { mcpServers?: Record<string, unknown>; [k: string]: unknown } = {}
  try {
    config = JSON.parse(readFileSync(claudeConfigPath(), 'utf-8'))
  } catch {
    // no config yet: start fresh
  }
  config.mcpServers = {
    ...(config.mcpServers ?? {}),
    [ENTRY_NAME]: {
      command: process.execPath,
      args: [installedServerPath()],
      env: {
        ELECTRON_RUN_AS_NODE: '1',
        MEETINGSCRIBE_DATA: app.getPath('userData'),
        // meeting links in Claude's answers open this build of the app
        ROWAN_URL_SCHEME: URL_SCHEME
      }
    }
  }
  writeFileSync(claudeConfigPath(), JSON.stringify(config, null, 2))
  return claudeConnectionStatus()
}

export function disconnectClaude(): ClaudeConnection {
  try {
    const config = JSON.parse(readFileSync(claudeConfigPath(), 'utf-8')) as {
      mcpServers?: Record<string, unknown>
    }
    if (config.mcpServers && ENTRY_NAME in config.mcpServers) {
      delete config.mcpServers[ENTRY_NAME]
      writeFileSync(claudeConfigPath(), JSON.stringify(config, null, 2))
    }
  } catch {
    // nothing to remove
  }
  return claudeConnectionStatus()
}
