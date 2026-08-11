import { app } from 'electron'
import { readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import type { MonthUsage, UsageSummary } from '../shared/types'

// ---------------------------------------------------------------------------
// Local API-cost tracking. Anthropic's billing API needs an admin key that
// regular API keys don't have, but every response reports exactly how many
// tokens it used — so each call is priced locally from the published list
// rates and accumulated into monthly buckets in userData/usage.json.
// Figures are estimates from token counts, not invoices.
// ---------------------------------------------------------------------------

/** $ per million tokens by model family (list prices; cache write 1.25x input, read 0.1x) */
const FAMILY_PRICES: [RegExp, { input: number; output: number }][] = [
  [/haiku/i, { input: 1, output: 5 }],
  [/opus/i, { input: 5, output: 25 }],
  [/sonnet/i, { input: 3, output: 15 }]
]

/** the shape of the SDK's response.usage that pricing needs */
interface TokenUsage {
  input_tokens: number
  output_tokens: number
  cache_creation_input_tokens?: number | null
  cache_read_input_tokens?: number | null
}

const EMPTY: MonthUsage = { costUsd: 0, calls: 0, inputTokens: 0, outputTokens: 0 }

function usagePath(): string {
  return join(app.getPath('userData'), 'usage.json')
}

function load(): Record<string, MonthUsage> {
  try {
    return JSON.parse(readFileSync(usagePath(), 'utf8'))
  } catch {
    return {}
  }
}

function monthKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

/** Price one API response and add it to the current month. Never throws. */
export function recordUsage(model: string, usage: TokenUsage): void {
  try {
    const price = FAMILY_PRICES.find(([re]) => re.test(model))?.[1] ?? { input: 3, output: 15 }
    const cacheWrite = usage.cache_creation_input_tokens ?? 0
    const cacheRead = usage.cache_read_input_tokens ?? 0
    const cost =
      (usage.input_tokens / 1e6) * price.input +
      (usage.output_tokens / 1e6) * price.output +
      (cacheWrite / 1e6) * price.input * 1.25 +
      (cacheRead / 1e6) * price.input * 0.1

    const data = load()
    const key = monthKey(new Date())
    const m = { ...(data[key] ?? EMPTY) }
    m.costUsd += cost
    m.calls += 1
    m.inputTokens += usage.input_tokens + cacheWrite + cacheRead
    m.outputTokens += usage.output_tokens
    data[key] = m
    writeFileSync(usagePath(), JSON.stringify(data, null, 2))
  } catch {
    // cost tracking must never break the pipeline
  }
}

export function getUsage(): UsageSummary {
  const data = load()
  const now = new Date()
  const prev = new Date(now.getFullYear(), now.getMonth() - 1, 1)
  return {
    thisMonth: data[monthKey(now)] ?? EMPTY,
    lastMonth: data[monthKey(prev)] ?? null
  }
}
