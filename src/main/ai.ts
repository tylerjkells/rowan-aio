import Anthropic from '@anthropic-ai/sdk'
import { getApiKey, getOpenaiKey, getSettings } from './settings'
import { recordUsage } from './usage'

// ---------------------------------------------------------------------------
// Provider layer: every AI feature in the app speaks one request shape
// (system + messages + optional JSON schema), routed to the provider chosen
// in Settings — Claude via the Anthropic SDK, ChatGPT via the OpenAI REST
// API. Callers never touch provider SDKs directly.
// ---------------------------------------------------------------------------

export interface AiMessage {
  role: 'user' | 'assistant'
  content: string
}

/**
 * One piece of a system prompt. cache marks the end of a prefix worth
 * reusing: a later request starting with byte-identical blocks reads it back
 * at a tenth of the price (Claude; ChatGPT caches long shared prefixes on its
 * own). Only mark it when a follow-up request will actually reuse it soon,
 * since writing the cache costs a quarter more than a plain read.
 */
export interface AiSystemBlock {
  text: string
  cache?: boolean
}

export interface AiRequest {
  /** defaults to the active provider's configured model */
  model?: string
  maxTokens: number
  system: string | AiSystemBlock[]
  messages: AiMessage[]
  /** JSON schema for structured output */
  schema?: Record<string, unknown>
  schemaName?: string
}

export interface AiResult {
  text: string
  stop: 'ok' | 'refusal' | 'max_tokens'
}

export function activeAiModel(): string {
  const s = getSettings()
  return s.aiProvider === 'openai' ? s.openaiModel : s.claudeModel
}

export function aiProviderName(): string {
  return getSettings().aiProvider === 'openai' ? 'ChatGPT' : 'Claude'
}

/** the active provider has a key saved */
export function aiReady(): boolean {
  const s = getSettings()
  return s.aiProvider === 'openai' ? s.hasOpenaiKey : s.hasApiKey
}

export async function aiChat(req: AiRequest): Promise<AiResult> {
  return getSettings().aiProvider === 'openai' ? openaiChat(req) : claudeChat(req)
}

async function claudeChat(req: AiRequest): Promise<AiResult> {
  const apiKey = getApiKey()
  if (!apiKey) {
    throw new Error('No Claude API key set. Add one in Settings to enable AI features.')
  }
  const client = new Anthropic({ apiKey })
  const model = req.model ?? getSettings().claudeModel
  // stream and collect: large max_tokens trips the SDK's "streaming required
  // for long operations" guard on plain create()
  const system: string | Anthropic.TextBlockParam[] =
    typeof req.system === 'string'
      ? req.system
      : req.system.map((b) => ({
          type: 'text' as const,
          text: b.text,
          ...(b.cache ? { cache_control: { type: 'ephemeral' as const } } : {})
        }))
  const response = await client.messages
    .stream({
      model,
      max_tokens: req.maxTokens,
      system,
      ...(req.schema
        ? { output_config: { format: { type: 'json_schema' as const, schema: req.schema } } }
        : {}),
      messages: req.messages
    })
    .finalMessage()
  recordUsage(model, response.usage)
  if (response.stop_reason === 'refusal') return { text: '', stop: 'refusal' }
  const text = response.content.find((b) => b.type === 'text')?.text ?? ''
  return { text, stop: response.stop_reason === 'max_tokens' ? 'max_tokens' : 'ok' }
}

interface OpenaiResponse {
  choices?: { message?: { content?: string | null }; finish_reason?: string }[]
  usage?: {
    prompt_tokens?: number
    completion_tokens?: number
    prompt_tokens_details?: { cached_tokens?: number }
  }
}

async function openaiChat(req: AiRequest): Promise<AiResult> {
  const apiKey = getOpenaiKey()
  if (!apiKey) {
    throw new Error('No OpenAI API key set. Add one in Settings to enable AI features.')
  }
  const model = req.model ?? getSettings().openaiModel
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      max_completion_tokens: req.maxTokens,
      // OpenAI caches a long shared prefix by itself; the blocks just join up
      messages: [
        {
          role: 'system',
          content:
            typeof req.system === 'string' ? req.system : req.system.map((b) => b.text).join('\n\n')
        },
        ...req.messages
      ],
      ...(req.schema
        ? {
            response_format: {
              type: 'json_schema',
              json_schema: { name: req.schemaName ?? 'result', strict: true, schema: req.schema }
            }
          }
        : {})
    })
  })
  if (!res.ok) {
    let msg = `OpenAI error ${res.status}`
    try {
      msg = ((await res.json()) as { error?: { message?: string } }).error?.message ?? msg
    } catch {
      // non-JSON error body
    }
    throw new Error(msg)
  }
  const data = (await res.json()) as OpenaiResponse
  // prompt_tokens includes the cached part, which bills at a discount
  const cached = data.usage?.prompt_tokens_details?.cached_tokens ?? 0
  recordUsage(model, {
    input_tokens: Math.max(0, (data.usage?.prompt_tokens ?? 0) - cached),
    output_tokens: data.usage?.completion_tokens ?? 0,
    cache_read_input_tokens: cached
  })
  const choice = data.choices?.[0]
  if (choice?.finish_reason === 'content_filter') return { text: '', stop: 'refusal' }
  return {
    text: choice?.message?.content ?? '',
    stop: choice?.finish_reason === 'length' ? 'max_tokens' : 'ok'
  }
}

/** Cheap round-trip to validate an OpenAI key when the user saves it. */
export async function testOpenaiKey(key: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch('https://api.openai.com/v1/models', {
      headers: { Authorization: `Bearer ${key.trim()}` }
    })
    if (res.ok) return { ok: true }
    if (res.status === 401) {
      return { ok: false, error: 'That API key was rejected. Double-check it and try again.' }
    }
    return { ok: false, error: `OpenAI error ${res.status}` }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Unknown error' }
  }
}
