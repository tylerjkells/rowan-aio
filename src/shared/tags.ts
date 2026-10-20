/**
 * Meeting tag dots. Muted, similar-lightness hues so a row of tags scans by
 * color without any one shouting; the color lives in the dot only, never the
 * pill. New tags take the next hue round-robin and keep it.
 */
export const TAG_COLORS = [
  '#4f7fc0', // blue
  '#c27a4e', // clay
  '#8a7bc4', // violet
  '#3f9b8c', // teal
  '#b9973f', // amber
  '#6f9a46', // olive
  '#c45d6a', // rose
  '#7d8b96' // slate
]

export function tagColor(index: number | undefined): string {
  return TAG_COLORS[(index ?? 0) % TAG_COLORS.length]
}

/** trim and collapse a typed tag; '' when nothing usable is left */
export function cleanTag(raw: string): string {
  return String(raw).replace(/\s+/g, ' ').trim().slice(0, 40)
}
