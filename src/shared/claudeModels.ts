// ---------------------------------------------------------------------------
// Claude models by family. Settings stores a family (Haiku, Sonnet, Opus),
// never a version, and each request runs on the newest model in it: the app
// asks Anthropic's Models API which exist (main/claudeModels.ts), and falls
// back to the newest it knew of when it was built.
// ---------------------------------------------------------------------------

export type ClaudeFamily = 'haiku' | 'sonnet' | 'opus'

export const CLAUDE_FAMILIES: ClaudeFamily[] = ['haiku', 'sonnet', 'opus']

export interface ClaudeModelInfo {
  /** the API's model id, e.g. claude-sonnet-5-5 */
  id: string
  /** e.g. Claude Sonnet 5.5 */
  name: string
}

/** the newest of each family */
export type ClaudeLineup = Record<ClaudeFamily, ClaudeModelInfo>

/** the newest of each as of this build; a newer one the Models API reports replaces it */
export const CLAUDE_FALLBACK: ClaudeLineup = {
  haiku: { id: 'claude-haiku-5-5', name: 'Claude Haiku 5.5' },
  sonnet: { id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5' },
  opus: { id: 'claude-opus-5-5', name: 'Claude Opus 5.5' }
}

/** the family a stored choice means: 'sonnet', or a version saved before families, like claude-sonnet-5 */
export function familyOf(choice: string | null | undefined): ClaudeFamily | null {
  const m = (choice ?? '').match(/haiku|sonnet|opus/i)
  return m ? (m[0].toLowerCase() as ClaudeFamily) : null
}
