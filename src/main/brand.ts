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
    return migrate(JSON.parse(readFileSync(file(), 'utf8')))
  } catch {
    saveBrand(BRAND_SEED)
    return BRAND_SEED
  }
}

/**
 * Early seeds shipped Metallic Gold with no screen value ("print only");
 * give existing libraries the approximation the seed now carries.
 */
function migrate(data: BrandData): BrandData {
  let changed = false
  const seedColors = BRAND_SEED.palettes.flatMap((p) => p.colors)
  for (const palette of data.palettes ?? []) {
    for (const color of palette.colors ?? []) {
      if (color.hex == null) {
        const seeded = seedColors.find((s) => s.name === color.name)
        if (seeded?.hex) {
          color.hex = seeded.hex
          delete color.printOnly
          changed = true
        }
      }
    }
  }
  if (changed) saveBrand(data)
  return data
}

export function saveBrand(data: BrandData): BrandData {
  mkdirSync(app.getPath('userData'), { recursive: true })
  writeFileSync(file(), JSON.stringify(data, null, 2))
  return data
}
