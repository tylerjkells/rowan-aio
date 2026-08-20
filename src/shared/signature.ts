// ---------------------------------------------------------------------------
// Email signature handling.
//
// Outlook applies a signature when *you* compose, so a draft created by the
// Power Automate bridge arrives without one. Rowan carries the signature
// itself: you paste it into Settings once, and it is appended to every draft
// on the way out.
//
// The paste comes off the clipboard as Outlook's HTML, which is a full Word
// document — conditional comments, stylesheets, `mso-` classes, namespaced
// tags. Everything that depends on an external stylesheet is dropped, because
// only what survives as inline markup will render in a mail client anyway.
// Sanitizing also matters for safety: the pasted HTML goes into the renderer's
// DOM, so scripts and event handlers cannot be allowed through.
// ---------------------------------------------------------------------------

/** A signature longer than this is a pasted email, not a signature. */
export const MAX_SIGNATURE_HTML = 20000

/** Tags worth keeping. Anything else is unwrapped, its text kept. */
const ALLOWED_TAGS = new Set([
  'a', 'b', 'strong', 'i', 'em', 'u', 's', 'span', 'div', 'p', 'br', 'hr',
  'table', 'thead', 'tbody', 'tr', 'td', 'th', 'font', 'ul', 'ol', 'li',
  'small', 'sub', 'sup', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6'
])

/** Attributes worth keeping. Class and id are dropped with the stylesheet. */
const ALLOWED_ATTRS = new Set([
  'style', 'href', 'title', 'color', 'size', 'face', 'align', 'valign',
  'width', 'height', 'cellpadding', 'cellspacing', 'border', 'bgcolor', 'target'
])

/** Tags whose contents go too, not just the tag. */
const DROP_WITH_CONTENT = /<(script|style|head|title|xml|object|iframe|embed)\b[\s\S]*?<\/\1\s*>/gi

function attributes(raw: string): string {
  const out: string[] = []
  const attr = /([a-zA-Z_:][-\w:.]*)\s*=\s*("[^"]*"|'[^']*'|[^\s"'>]+)/g
  let m: RegExpExecArray | null
  while ((m = attr.exec(raw))) {
    const name = m[1].toLowerCase()
    if (!ALLOWED_ATTRS.has(name)) continue
    const value = m[2].replace(/^["']|["']$/g, '')
    // a javascript: or data: href is the one way a link can still bite
    if (name === 'href' && /^\s*(javascript|data|vbscript):/i.test(value)) continue
    out.push(`${name}="${value.replace(/"/g, '&quot;')}"`)
  }
  return out.length ? ` ${out.join(' ')}` : ''
}

/**
 * Reduce pasted clipboard HTML to inline markup a mail client will render.
 * Text-only by design: images are dropped, because a signature logo would
 * arrive as a `cid:` or temp-file reference that means nothing in a draft.
 */
export function sanitizeSignatureHtml(raw: string): string {
  if (!raw) return ''

  let html = raw.slice(0, MAX_SIGNATURE_HTML * 4)

  // clipboard HTML wraps the real selection in fragment markers
  const fragment = html.match(/<!--\s*StartFragment\s*-->([\s\S]*?)<!--\s*EndFragment\s*-->/i)
  if (fragment) html = fragment[1]

  html = html.replace(DROP_WITH_CONTENT, '')
  html = html.replace(/<!--[\s\S]*?-->/g, '')
  html = html.replace(/<img\b[^>]*>/gi, '')
  html = html.replace(/<\/?(?:o|v|w|st1|m):[^>]*>/gi, '')

  html = html.replace(/<\/?([a-zA-Z][\w:-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g, (tag, name, rest) => {
    const lower = String(name).toLowerCase()
    if (!ALLOWED_TAGS.has(lower)) return ''
    if (tag.startsWith('</')) return `</${lower}>`
    const selfClosing = /\/\s*$/.test(rest) || lower === 'br' || lower === 'hr'
    return `<${lower}${attributes(rest)}${selfClosing ? ' /' : ''}>`
  })

  // anything left that looks like a tag never was one
  html = html.replace(/<(?![a-zA-Z/])/g, '&lt;')

  return collapse(html).slice(0, MAX_SIGNATURE_HTML)
}

/**
 * Trim the empty paragraphs and stray whitespace a paste leaves behind. The
 * blank block Outlook parks after a signature sits *inside* the wrapper div,
 * so the sweep has to see past the closing tags to find it.
 */
const BLANK_INSIDE =
  '(?:\\s|&nbsp;|<br\\s*/?>|</?(?:span|b|i|u|em|strong|font|small)[^>]*>)*'

const TRAILING_BLANK = new RegExp(
  `(<(p|div)[^>]*>${BLANK_INSIDE}</\\2>\\s*)(?=(?:</(?:div|p|td|tr|table)>\\s*)*$)`,
  'i'
)

function collapse(html: string): string {
  let out = html.replace(/\s*\n\s*/g, ' ')
  for (let i = 0; i < 20 && TRAILING_BLANK.test(out); i++) {
    out = out.replace(TRAILING_BLANK, '')
  }
  return out
    .replace(/^(?:\s|(?:<br\s*\/?>))+/i, '')
    .replace(/(?:\s|(?:<br\s*\/?>))+$/i, '')
    .trim()
}

const ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '-', mdash: '-'
}

function decode(text: string): string {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, body: string) => {
    if (body.startsWith('#')) {
      const code = body[1] === 'x' || body[1] === 'X'
        ? parseInt(body.slice(2), 16)
        : parseInt(body.slice(1), 10)
      return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : whole
    }
    return ENTITIES[body.toLowerCase()] ?? whole
  })
}

/**
 * The same signature as plain text, for the draft file's `body` field — the
 * flow falls back to it when the HTML is missing.
 */
export function signatureToText(html: string): string {
  if (!html) return ''
  return decode(
    html
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|tr|li|h[1-6])>/gi, '\n')
      .replace(/<\/t[dh]>/gi, ' ')
      .replace(/<[^>]*>/g, '')
  )
    .replace(/[ \t ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}
