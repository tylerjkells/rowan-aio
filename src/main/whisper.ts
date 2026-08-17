import { app } from 'electron'
import { spawn } from 'child_process'
import { cpus } from 'os'
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  createWriteStream
} from 'fs'
import { join } from 'path'
import { Readable } from 'stream'
import { pipeline } from 'stream/promises'
import type { EngineProgress, EngineStatus, TranscriptSegment, WhisperModel } from '../shared/types'

const MODEL_URLS: Record<WhisperModel, string> = {
  'base.en': 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin',
  'small.en': 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.en.bin',
  'medium.en': 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-medium.en.bin',
  // tinydiarize variant: same accuracy class as small.en, plus speaker-turn markers
  'small.en-tdrz':
    'https://huggingface.co/akashmjn/tinydiarize-whisper.cpp/resolve/main/ggml-small.en-tdrz.bin'
}

function engineDir(): string {
  const dir = join(app.getPath('userData'), 'engine')
  mkdirSync(dir, { recursive: true })
  return dir
}

function modelsDir(): string {
  const dir = join(engineDir(), 'models')
  mkdirSync(dir, { recursive: true })
  return dir
}

export function modelPath(model: WhisperModel): string {
  return join(modelsDir(), `ggml-${model}.bin`)
}

function findBinary(): string | null {
  const dir = join(engineDir(), 'bin')
  if (!existsSync(dir)) return null
  let fallback: string | null = null
  const stack = [dir]
  while (stack.length) {
    const cur = stack.pop()!
    for (const entry of readdirSync(cur, { withFileTypes: true })) {
      const full = join(cur, entry.name)
      if (entry.isDirectory()) stack.push(full)
      else if (/^whisper-cli\.exe$/i.test(entry.name)) return full
      else if (/^main\.exe$/i.test(entry.name)) fallback = full
    }
  }
  return fallback
}

export function engineStatus(preferredModel: WhisperModel): EngineStatus {
  const models = (Object.keys(MODEL_URLS) as WhisperModel[]).filter((m) => {
    const p = modelPath(m)
    // partial downloads are smaller than any real model (~140MB minimum)
    return existsSync(p) && statSync(p).size > 50_000_000
  })
  return {
    binaryReady: findBinary() !== null,
    modelReady: models.includes(preferredModel),
    models
  }
}

type ProgressFn = (p: EngineProgress) => void

async function downloadWithProgress(
  url: string,
  dest: string,
  phase: EngineProgress['phase'],
  label: string,
  onProgress: ProgressFn
): Promise<void> {
  const res = await fetch(url, { redirect: 'follow' })
  if (!res.ok || !res.body) throw new Error(`Download failed (${res.status}) for ${label}`)
  const total = Number(res.headers.get('content-length') ?? 0)
  let received = 0
  const tmp = dest + '.part'
  const counter = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      received += chunk.byteLength
      const percent = total ? Math.round((received / total) * 100) : -1
      onProgress({ phase, percent, detail: `${label} — ${(received / 1048576).toFixed(0)} MB${total ? ` of ${(total / 1048576).toFixed(0)} MB` : ''}` })
      controller.enqueue(chunk)
    }
  })
  await pipeline(Readable.fromWeb(res.body.pipeThrough(counter) as never), createWriteStream(tmp))
  rmSync(dest, { force: true })
  const { renameSync } = await import('fs')
  renameSync(tmp, dest)
}

/** Pick the plain CPU x64 zip from the latest whisper.cpp GitHub release. */
async function resolveBinaryAssetUrl(): Promise<string> {
  const res = await fetch('https://api.github.com/repos/ggml-org/whisper.cpp/releases/latest', {
    headers: { accept: 'application/vnd.github+json', 'user-agent': 'meeting-scribe' }
  })
  if (!res.ok) throw new Error(`Could not query whisper.cpp releases (${res.status})`)
  const release = (await res.json()) as { assets: { name: string; browser_download_url: string }[] }
  const assets = release.assets ?? []
  const candidates = assets.filter(
    (a) =>
      /x64/i.test(a.name) &&
      /\.zip$/i.test(a.name) &&
      /bin/i.test(a.name) &&
      !/(cublas|cuda|blas|arm|clblast|openvino)/i.test(a.name)
  )
  const asset = candidates[0] ?? assets.find((a) => /bin-x64\.zip$/i.test(a.name))
  if (!asset) throw new Error('No Windows x64 binary asset found in the latest whisper.cpp release')
  return asset.browser_download_url
}

export async function setupEngine(model: WhisperModel, onProgress: ProgressFn): Promise<EngineStatus> {
  if (!findBinary()) {
    onProgress({ phase: 'binary', percent: -1, detail: 'Locating transcription engine…' })
    const url = await resolveBinaryAssetUrl()
    const zipPath = join(engineDir(), 'whisper-bin.zip')
    await downloadWithProgress(url, zipPath, 'binary', 'Transcription engine', onProgress)

    onProgress({ phase: 'binary', percent: -1, detail: 'Unpacking engine…' })
    const binDir = join(engineDir(), 'bin')
    rmSync(binDir, { recursive: true, force: true })
    mkdirSync(binDir, { recursive: true })
    // Windows 10+ ships bsdtar (which extracts zip archives) in System32.
    // Use the absolute path: a Git Bash GNU tar earlier in PATH cannot read zips.
    const tar = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe')
    await new Promise<void>((resolve, reject) => {
      const p = spawn(tar, ['-xf', zipPath, '-C', binDir], { windowsHide: true })
      let err = ''
      p.stderr.on('data', (d) => (err += d))
      p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`Unzip failed: ${err}`))))
      p.on('error', reject)
    })
    rmSync(zipPath, { force: true })
    if (!findBinary()) throw new Error('Engine unpacked but whisper-cli.exe was not found inside')
  }

  const mp = modelPath(model)
  if (!existsSync(mp) || statSync(mp).size < 50_000_000) {
    await downloadWithProgress(MODEL_URLS[model], mp, 'model', `Speech model (${model})`, onProgress)
  }

  onProgress({ phase: 'model', percent: 100, detail: 'Ready', done: true })
  return engineStatus(model)
}

interface WhisperJsonOutput {
  transcription: {
    offsets: { from: number; to: number }
    text: string
    speaker_turn_next?: boolean
  }[]
}

export interface TranscribeOptions {
  threads?: number
  /** context from preceding audio to keep decoding coherent across chunks */
  prompt?: string
  onProgress?: (percent: number) => void
}

/** Full-quality default: most of the machine, leaving headroom for the app
 *  and the user's meeting software. */
export function defaultThreads(): number {
  return Math.max(4, Math.min(12, cpus().length - 4))
}

/** Conservative thread count for transcribing while a meeting is live. */
export function liveThreads(): number {
  return Math.max(2, Math.min(6, cpus().length - 8))
}

export async function transcribeFile(
  wavFile: string,
  model: WhisperModel,
  opts: TranscribeOptions = {}
): Promise<TranscriptSegment[]> {
  const binary = findBinary()
  if (!binary) throw new Error('Transcription engine is not installed yet')
  const mp = modelPath(model)
  if (!existsSync(mp)) throw new Error(`Speech model ${model} is not downloaded yet`)

  const outBase = wavFile.replace(/\.wav$/i, '')
  const args = [
    '-m', mp,
    '-f', wavFile,
    '-oj',
    '-of', outBase,
    '-l', 'en',
    '-t', String(opts.threads ?? defaultThreads())
  ]
  if (model === 'small.en-tdrz') args.push('--tinydiarize')
  if (opts.prompt) args.push('--prompt', opts.prompt)
  if (opts.onProgress) args.push('--print-progress')

  await new Promise<void>((resolve, reject) => {
    const p = spawn(binary, args, { windowsHide: true })
    let stderr = ''
    p.stderr.on('data', (d: Buffer) => {
      const s = d.toString()
      stderr += s
      if (!opts.onProgress) return
      const m = s.match(/progress\s*=\s*(\d+)%/g)
      if (m) {
        const last = m[m.length - 1].match(/(\d+)%/)
        if (last) opts.onProgress(Number(last[1]))
      }
    })
    p.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`Whisper exited with code ${code}: ${stderr.slice(-800)}`))
    )
    p.on('error', reject)
  })

  const jsonPath = outBase + '.json'
  const parsed = JSON.parse(readFileSync(jsonPath, 'utf-8')) as WhisperJsonOutput
  rmSync(jsonPath, { force: true })

  return (parsed.transcription ?? [])
    .map((t) => ({
      from: t.offsets.from,
      to: t.offsets.to,
      text: t.text.trim(),
      ...(t.speaker_turn_next === true ? { turn: true } : {})
    }))
    .filter((t) => t.text.length > 0 && !isHallucination(t.text))
}

// On silence, Whisper hallucinates lines from its training data — subtitle
// credits ("Subs by www.zeoranger.co.uk", Amara.org), sign-offs ("Thanks for
// watching"), and stray fillers. None of it came from the room; drop it.
const HALLUCINATED_PHRASES =
  /\b(subs? by|subtitles? (by|made)|amara\.org|zeoranger|thanks? (you )?(all )?for watching|please subscribe|like and subscribe|mooji)\b/i
const FILLER_ONLY = /^[\s.!?,'-]*(uh|um|oh|ah|hm+|mm+(-?hmm?)?|huh)?[\s.!?,'-]*$/i

function isHallucination(text: string): boolean {
  return HALLUCINATED_PHRASES.test(text) || FILLER_ONLY.test(text)
}

export async function transcribe(
  wavFile: string,
  model: WhisperModel,
  onProgress: (percent: number) => void,
  prompt?: string
): Promise<TranscriptSegment[]> {
  return transcribeFile(wavFile, model, { onProgress, prompt })
}

/**
 * User vocabulary (names, acronyms, jargon) shaped into a whisper prompt.
 * Whisper's prompt window is small, so the list is capped.
 */
export function vocabularyPrompt(vocabulary: string): string {
  const v = vocabulary.trim().replace(/\s+/g, ' ')
  return v ? v.slice(0, 400) : ''
}
