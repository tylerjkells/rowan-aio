// ---------------------------------------------------------------------------
// House voice rules for anything the model writes for the user to read or
// send. Adapted from the humanizer skill Tyler uses for coursework, keeping
// the parts that survive the move from an essay to a work email.
//
// What carried over: the em dash ban, the AI vocabulary list, varied sentence
// length, no tidy summarizing closer, no mirrored parallel constructions, no
// reflexive lists of three. What did not: "have opinions and react to the
// material", "let thoughts trail off", "open with a blunt one-word answer".
// That advice makes a discussion post read as human and makes an email to a
// colleague read as odd. The goal here is sounding like Tyler, not beating a
// detector.
// ---------------------------------------------------------------------------

/** the hard bans, short enough to paste into any system prompt */
export const VOICE_RULES = `Voice:
- Never use an em dash or en dash. Not once. Use a comma, a period, or parentheses.
  This is the strongest tell there is.
- Never use these words: delve, tapestry, landscape (as metaphor), pivotal, foster,
  underscore, showcase, vibrant, crucial, intricate, testament, enhance, garner,
  interplay, leverage, facilitate, utilize, robust, seamless, myriad. Never open a
  sentence with Furthermore, Additionally, or Moreover. Never write "serves as",
  "stands as", or "functions as".
- Vary sentence length. Some short, some long. Uniform sentence rhythm is the
  second strongest tell.
- Do not end with a sentence that summarizes or restates what you just said. Stop
  when the point is made.
- Do not mirror two halves of a sentence against each other, and do not use
  "not because A, but because B".
- Do not reach for a list of three. If you have written "X, Y, and Z", cut one or
  fold two together.
- Contractions are normal. Use them.
- Prefer the plain word over the formal one: "use" not "utilize", "help" not
  "facilitate", "start" not "commence".`

/**
 * Backstop for the em dash rule. Models slip, and one dash undoes the whole
 * effect, so strip them after generation rather than trusting the prompt.
 * A comma is the substitution that stays grammatical in the most cases.
 */
export function stripDashes(text: string): string {
  return text
    // " — " and "—" both become a comma, collapsing any doubled punctuation
    .replace(/\s*[—–]\s*/g, ', ')
    .replace(/,\s*,/g, ',')
    .replace(/([,.;:!?])\s*,/g, '$1')
    .replace(/,\s*([.;:!?])/g, '$1')
}
