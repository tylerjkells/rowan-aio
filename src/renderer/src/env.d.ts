/// <reference types="vite/client" />

// Chromium mediacapture-transform API (not yet in TypeScript's DOM lib)
interface AudioDataCopyToOptions {
  planeIndex: number
  format?: string
  frameOffset?: number
  frameCount?: number
}

interface AudioData {
  readonly numberOfFrames: number
  readonly numberOfChannels: number
  readonly sampleRate: number
  readonly format: string | null
  copyTo(destination: BufferSource, options: AudioDataCopyToOptions): void
  close(): void
}

declare class MediaStreamTrackProcessor {
  constructor(init: { track: MediaStreamTrack; maxBufferSize?: number })
  readonly readable: ReadableStream<AudioData>
}

// React declares <webview> with an empty element type; these are the parts of
// Electron's WebviewTag the Dashboards tab calls
interface HTMLWebViewElement {
  reload(): void
  goBack(): void
  canGoBack(): boolean
  loadURL(url: string): Promise<void>
}
