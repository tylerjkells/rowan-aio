import { createHash } from 'crypto'

// ---------------------------------------------------------------------------
// Three-way JSON merge for sync. Every synced document is plain JSON, so one
// generic merge covers meetings, the planner, links, settings and the rest:
//
//   - objects merge key by key, so an edit to a meeting's notes on one PC and
//     to its title on another both survive;
//   - arrays whose items all carry an `id` merge item by item (planner items,
//     links, toolbox entries), keeping additions from both sides;
//   - arrays of plain strings or numbers merge as sets (tags, the people
//     roster, hidden tabs);
//   - arrays both sides only appended to keep both sets of appends (Ask
//     history);
//   - anything else both sides changed (a transcript, a summary paragraph)
//     goes to the side named by `prefer`.
//
// A value changed on one side and deleted on the other keeps the change:
// losing an edit is worse than resurrecting something.
// ---------------------------------------------------------------------------

export type Prefer = 'local' | 'remote'

type Obj = Record<string, unknown>

function isObj(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** JSON with object keys sorted, so equal values always serialize the same */
export function canonical(v: unknown): string {
  if (v === undefined) return '~'
  if (v === null || typeof v !== 'object') return JSON.stringify(v)
  if (Array.isArray(v)) {
    return `[${v.map((x) => (x === undefined ? 'null' : canonical(x))).join(',')}]`
  }
  const o = v as Obj
  const keys = Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort()
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`).join(',')}}`
}

export function hashOf(v: unknown): string {
  return createHash('sha256').update(canonical(v)).digest('hex')
}

export function equal(a: unknown, b: unknown): boolean {
  if (a === b) return true
  return canonical(a) === canonical(b)
}

const LONE_SURROGATES = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g
const REPLACEMENT_CHAR = String.fromCharCode(0xfffd)
const HAS_LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/

/**
 * What Postgres jsonb will accept: no NUL characters, no lone UTF-16
 * surrogates, no undefined. Local documents are always read through this so
 * a stored copy and the local file compare equal.
 */
export function sanitize(v: unknown): unknown {
  if (typeof v === 'string') {
    return v.includes('\u0000') || HAS_LONE_SURROGATE.test(v)
      ? v.replace(/\u0000/g, '').replace(LONE_SURROGATES, REPLACEMENT_CHAR)
      : v
  }
  if (Array.isArray(v)) return v.map((x) => (x === undefined ? null : sanitize(x)))
  if (isObj(v)) {
    const out: Obj = {}
    for (const [k, x] of Object.entries(v)) {
      if (x !== undefined) out[sanitize(k) as string] = sanitize(x)
    }
    return out
  }
  if (typeof v === 'number' && !Number.isFinite(v)) return null
  return v
}

function idOf(x: unknown): string | null {
  if (!isObj(x)) return null
  const id = x.id
  return typeof id === 'string' || typeof id === 'number' ? String(id) : null
}

/** every item an object with a unique id */
function keyed(arr: unknown[]): boolean {
  const seen = new Set<string>()
  for (const x of arr) {
    const id = idOf(x)
    if (id === null || seen.has(id)) return false
    seen.add(id)
  }
  return true
}

/** every item a string, number or boolean, with no repeats */
function primitiveSet(arr: unknown[]): boolean {
  const seen = new Set<unknown>()
  for (const x of arr) {
    if (x === null || typeof x === 'object' || seen.has(x)) return false
    seen.add(x)
  }
  return true
}

function isPrefix(prefix: unknown[], arr: unknown[]): boolean {
  if (prefix.length > arr.length) return false
  for (let i = 0; i < prefix.length; i++) if (!equal(prefix[i], arr[i])) return false
  return true
}

function mergeKeyed(
  base: unknown[] | undefined,
  local: unknown[],
  remote: unknown[],
  prefer: Prefer
): unknown[] {
  const byId = (arr: unknown[]): Map<string, unknown> =>
    new Map(arr.map((x) => [idOf(x) as string, x]))
  const L = byId(local)
  const R = byId(remote)
  const B = base ? byId(base) : undefined
  // follow local's ordering only when remote kept the base's (so a reorder
  // or an insert at the top made here survives); otherwise remote's
  const remoteKeptOrder =
    base !== undefined && equal(base.map(idOf), remote.map(idOf))
  const primary = remoteKeptOrder ? local : remote
  const secondary = remoteKeptOrder ? remote : local
  const order = primary.map((x) => idOf(x) as string)
  const placed = new Set(order)
  for (const x of secondary) {
    const id = idOf(x) as string
    if (!placed.has(id)) {
      order.push(id)
      placed.add(id)
    }
  }
  const out: unknown[] = []
  for (const id of order) {
    // an id missing from the base was added: merge3 keeps it whichever side has it
    const m = merge3(B?.get(id), L.get(id), R.get(id), prefer)
    if (m !== undefined) out.push(m)
  }
  return out
}

function mergeSet(base: unknown[] | undefined, local: unknown[], remote: unknown[]): unknown[] {
  if (!base) return [...remote, ...local.filter((x) => !remote.includes(x))]
  const removed = new Set(base.filter((x) => !local.includes(x)))
  const added = local.filter((x) => !base.includes(x) && !remote.includes(x))
  return [...remote.filter((x) => !removed.has(x)), ...added]
}

/**
 * Merge `local` and `remote`, both descended from `base`. `base` is
 * undefined when the two never shared a version (the first sync of a PC
 * that already had data): then anything present on only one side is kept.
 */
/** two lists of action items holding the same tasks in the same order */
function sameTasks(a: unknown[], b: unknown[]): boolean {
  return (
    a.length > 0 &&
    a.length === b.length &&
    a.every((x, i) => isObj(x) && isObj(b[i]) && typeof x.task === 'string' && x.task === b[i].task)
  )
}

export function merge3(base: unknown, local: unknown, remote: unknown, prefer: Prefer): unknown {
  if (equal(local, remote)) return local
  if (base !== undefined) {
    if (equal(base, local)) return remote
    if (equal(base, remote)) return local
  }

  // both sides moved away from the base (or there is none)
  if (local === undefined) return remote
  if (remote === undefined) return local

  if (isObj(local) && isObj(remote)) {
    const b = isObj(base) ? base : undefined
    const out: Obj = {}
    const keys = [...Object.keys(local), ...Object.keys(remote).filter((k) => !(k in local))]
    for (const k of keys) {
      const m = merge3(b?.[k], local[k], remote[k], prefer)
      if (m !== undefined) out[k] = m
    }
    return out
  }

  if (Array.isArray(local) && Array.isArray(remote)) {
    const b = Array.isArray(base) ? base : undefined
    if (keyed(local) && keyed(remote) && (!b || keyed(b))) {
      return mergeKeyed(b, local, remote, prefer)
    }
    if (primitiveSet(local) && primitiveSet(remote) && (!b || primitiveSet(b))) {
      return mergeSet(b, local, remote)
    }
    // a meeting's action items, the same ones on every side, with flags
    // changed in place (one marked done here, another added to the list
    // there): merge them item by item. Anything else, such as a transcript
    // or a re-summarized list, is still taken whole from one side.
    if (b && sameTasks(b, local) && sameTasks(b, remote)) {
      return local.map((x, i) => merge3(b[i], x, remote[i], prefer))
    }
    if (b && isPrefix(b, local) && isPrefix(b, remote)) {
      const remoteAdds = remote.slice(b.length)
      const localAdds = local.slice(b.length).filter((x) => !remoteAdds.some((y) => equal(x, y)))
      return [...b, ...remoteAdds, ...localAdds]
    }
  }

  return prefer === 'local' ? local : remote
}
