import { app } from 'electron'
import { mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { BRAND_SEED } from '../shared/brandSeed'
import type { BrandData } from '../shared/types'

// ---------------------------------------------------------------------------
// Brand guide: palettes and usage notes in userData/brand.json, seeded from
// the Rowan brand standards on first access. The whole document is small, so
// the renderer edits it in place and saves it back entire.
// ---------------------------------------------------------------------------

function file(): string {
  return join(app.getPath('userData'), 'brand.json')
}

export function getBrand(): BrandData {
  try {
    return JSON.parse(readFileSync(file(), 'utf8'))
  } catch {
    saveBrand(BRAND_SEED)
    return BRAND_SEED
  }
}

export function saveBrand(data: BrandData): BrandData {
  mkdirSync(app.getPath('userData'), { recursive: true })
  writeFileSync(file(), JSON.stringify(data, null, 2))
  return data
}
