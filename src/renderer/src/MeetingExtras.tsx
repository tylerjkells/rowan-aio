import { useEffect, useRef, useState } from 'react'
import type { Meeting, TagInfo } from '../../shared/types'
import { cleanTag, tagColor } from '../../shared/tags'

// ---------------------------------------------------------------------------
// Pieces of the meeting page: tags, in-place summary editing, the one-off
// instructions dialog behind Regenerate, and notes whose time stamps jump to
// that moment of the recording.
// ---------------------------------------------------------------------------

/** a tag: neutral pill, the color in the dot only */
export function TagPill({
  name,
  color,
  compact = false,
  onRemove
}: {
  name: string
  color: number | undefined
  compact?: boolean
  onRemove?: () => void
}): React.JSX.Element {
  return (
    <span className={`tag-pill ${compact ? 'compact' : ''}`}>
      <span className="tag-dot" style={{ background: tagColor(color) }} aria-hidden="true" />
      {name}
      {onRemove && (
        <button
          className="tag-x"
          onClick={(e) => {
            e.stopPropagation()
            onRemove()
          }}
          aria-label={`Remove tag ${name}`}
          title="Remove this tag"
        >
          ×
        </button>
      )}
    </span>
  )
}

/**
 * The meeting's tags in order applied, then a ghost "+ Tag" pill that opens
 * a picker: search the tags already in use, click to toggle, or create one.
 */
export function TagRow({
  meeting,
  onSaved
}: {
  meeting: Meeting
  onSaved: (m: Meeting) => void
}): React.JSX.Element {
  const [catalog, setCatalog] = useState<TagInfo[]>([])
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [hi, setHi] = useState(0)
  const wrapRef = useRef<HTMLSpanElement>(null)
  const tags = meeting.tags ?? []

  useEffect(() => {
    window.scribe.tags.all().then(setCatalog)
  }, [meeting.tags])

  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent): void => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [open])

  const colorOf = (name: string): number | undefined =>
    catalog.find((c) => c.name.toLowerCase() === name.toLowerCase())?.color
  const has = (name: string): boolean => tags.some((t) => t.toLowerCase() === name.toLowerCase())

  async function save(next: string[]): Promise<void> {
    const updated = await window.scribe.meetings.setTags(meeting.id, next)
    if (updated) onSaved(updated)
  }

  function toggle(name: string): void {
    save(has(name) ? tags.filter((t) => t.toLowerCase() !== name.toLowerCase()) : [...tags, name])
  }

  const q = query.trim().toLowerCase()
  const options = catalog.filter((c) => !q || c.name.toLowerCase().includes(q))
  const fresh = cleanTag(query)
  const canCreate = !!fresh && !catalog.some((c) => c.name.toLowerCase() === fresh.toLowerCase())
  const rows = [...options.map((o) => o.name), ...(canCreate ? [`+${fresh}`] : [])]

  function pick(row: string | undefined): void {
    if (!row) return
    if (row.startsWith('+') && canCreate && row === `+${fresh}`) {
      save([...tags, fresh])
      setQuery('')
    } else {
      toggle(row)
    }
  }

  return (
    <div className="tag-row">
      {tags.map((t) => (
        <TagPill
          key={t}
          name={t}
          color={colorOf(t)}
          onRemove={() => save(tags.filter((x) => x !== t))}
        />
      ))}
      <span className="tag-add-wrap" ref={wrapRef}>
        <button
          className="tag-add"
          onClick={() => {
            setOpen(!open)
            setQuery('')
            setHi(0)
          }}
          aria-expanded={open}
        >
          + Tag
        </button>
        {open && (
          <div className="tag-pop" role="dialog" aria-label="Tags">
            <input
              className="text-input tag-search"
              autoFocus
              placeholder="Find or create a tag"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value)
                setHi(0)
              }}
              onKeyDown={(e) => {
                if (e.key === 'ArrowDown') {
                  e.preventDefault()
                  setHi((h) => Math.min(h + 1, rows.length - 1))
                } else if (e.key === 'ArrowUp') {
                  e.preventDefault()
                  setHi((h) => Math.max(h - 1, 0))
                } else if (e.key === 'Enter') {
                  e.preventDefault()
                  pick(rows[hi])
                } else if (e.key === 'Escape') {
                  setOpen(false)
                }
              }}
            />
            {options.length > 0 && <div className="tag-pop-kicker">Tags</div>}
            {options.map((o, i) => (
              <button
                key={o.name}
                className={`tag-opt ${i === hi ? 'hi' : ''}`}
                onMouseDown={(e) => {
                  e.preventDefault()
                  toggle(o.name)
                }}
              >
                <span className="tag-dot" style={{ background: tagColor(o.color) }} aria-hidden="true" />
                <span className="tag-opt-name">{o.name}</span>
                <span className="tag-opt-count">{o.count}</span>
                <span className="tag-opt-check" aria-hidden="true">
                  {has(o.name) ? '✓' : ''}
                </span>
              </button>
            ))}
            {canCreate && (
              <button
                className={`tag-opt create ${hi === options.length ? 'hi' : ''}`}
                onMouseDown={(e) => {
                  e.preventDefault()
                  pick(`+${fresh}`)
                }}
              >
                + Create &ldquo;{fresh}&rdquo;
              </button>
            )}
            {rows.length === 0 && <p className="tag-pop-empty">Type a name to create your first tag.</p>}
          </div>
        )}
      </span>
    </div>
  )
}

/** a textarea that grows with its text */
function GrowingText({
  value,
  onChange,
  onBlur,
  placeholder,
  className,
  autoFocus
}: {
  value: string
  onChange: (v: string) => void
  onBlur: () => void
  placeholder?: string
  className?: string
  autoFocus?: boolean
}): React.JSX.Element {
  const ref = useRef<HTMLTextAreaElement>(null)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight + 2}px`
  }, [value])
  return (
    <textarea
      ref={ref}
      rows={1}
      className={`text-input sum-edit ${className ?? ''}`}
      value={value}
      placeholder={placeholder}
      autoFocus={autoFocus}
      onChange={(e) => onChange(e.target.value)}
      onBlur={onBlur}
    />
  )
}

/** one editable block of summary text; saves when focus leaves */
export function EditableText({
  value,
  onSave,
  placeholder
}: {
  value: string
  onSave: (v: string) => void
  placeholder?: string
}): React.JSX.Element {
  const [draft, setDraft] = useState(value)
  useEffect(() => setDraft(value), [value])
  return (
    <GrowingText
      value={draft}
      onChange={setDraft}
      placeholder={placeholder}
      onBlur={() => {
        if (draft.trim() !== value.trim()) onSave(draft)
      }}
    />
  )
}

/**
 * A summary list (decisions, open questions, a topic's notes) as editable
 * lines: each saves when focus leaves, × removes it, and a final row adds one.
 */
export function EditableList({
  items,
  onSave,
  addLabel = 'Add a line'
}: {
  items: string[]
  onSave: (items: string[]) => void
  addLabel?: string
}): React.JSX.Element {
  const [drafts, setDrafts] = useState(items)
  const [focusLast, setFocusLast] = useState(false)
  useEffect(() => setDrafts(items), [items])

  function commit(next: string[]): void {
    const clean = next.map((x) => x.trim()).filter(Boolean)
    if (clean.join('\n') !== items.map((x) => x.trim()).join('\n')) onSave(clean)
  }

  return (
    <div className="sum-list">
      {drafts.map((d, i) => (
        <div className="sum-line" key={i}>
          <GrowingText
            value={d}
            autoFocus={focusLast && i === drafts.length - 1}
            onChange={(v) => setDrafts(drafts.map((x, j) => (j === i ? v : x)))}
            onBlur={() => {
              setFocusLast(false)
              commit(drafts)
            }}
          />
          <button
            className="seg-tool"
            title="Remove this line"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => {
              const next = drafts.filter((_, j) => j !== i)
              setDrafts(next)
              commit(next)
            }}
          >
            ✕
          </button>
        </div>
      ))}
      <button
        className="link-btn sum-add"
        onClick={() => {
          setDrafts([...drafts, ''])
          setFocusLast(true)
        }}
      >
        + {addLabel}
      </button>
    </div>
  )
}

/**
 * Regenerate with a one-off ask ("focus on the budget discussion", "this was
 * a 1:1, include coaching points"). The standing instructions from Settings
 * still apply; these are added for this run only.
 */
export function InstructionsDialog({
  standing,
  edited,
  onRun,
  onClose
}: {
  /** the instructions from Settings that apply anyway */
  standing: string
  /** the summary has hand edits that a rerun will replace */
  edited: boolean
  onRun: (instructions: string) => void
  onClose: () => void
}): React.JSX.Element {
  const ref = useRef<HTMLDialogElement>(null)
  const [text, setText] = useState('')
  useEffect(() => {
    ref.current?.showModal()
  }, [])
  const examples = [
    'Focus on the budget discussion and list every figure mentioned.',
    'This was a 1:1. Add a section with coaching points and feedback.',
    'Write the action items as ClickUp-ready tasks with a clear first step.'
  ]
  return (
    <dialog
      ref={ref}
      className="confirm person-edit"
      onClose={onClose}
      onClick={(e) => {
        if (e.target === ref.current) onClose()
      }}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault()
          if (!text.trim()) return
          onRun(text.trim())
          onClose()
        }}
      >
        <h3>Regenerate with instructions</h3>
        <p className="opt-desc">
          Tell the summary what to do differently this time. Only this run uses them.
          {standing ? ' Your standing instructions from Settings apply too.' : ''}
        </p>
        <textarea
          className="text-input instr-input"
          autoFocus
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="e.g. Focus on the hiring decisions and who owns each next step."
        />
        <div className="instr-examples">
          {examples.map((x) => (
            <button type="button" key={x} className="who-chip" onClick={() => setText(x)}>
              {x}
            </button>
          ))}
        </div>
        {edited && (
          <p className="field-note error">
            You have edited this summary by hand. Regenerating replaces those edits.
          </p>
        )}
        <div className="confirm-actions">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={!text.trim()}>
            Regenerate
          </button>
        </div>
      </form>
    </dialog>
  )
}

const STAMP = /^\[(\d{1,3}):(\d{2})(?::(\d{2}))?\]\s?/

/** "[12:34] text" → 754000; null for a line without a stamp */
export function stampMs(line: string): number | null {
  const m = STAMP.exec(line)
  if (!m) return null
  const [a, b, c] = [Number(m[1]), Number(m[2]), m[3] !== undefined ? Number(m[3]) : null]
  return (c === null ? a * 60 + b : a * 3600 + b * 60 + c) * 1000
}

/**
 * Notes as read: lines typed during the recording start with the moment they
 * were typed, and clicking that stamp plays the recording from there. Click
 * anywhere else to edit.
 */
export function NotesView({
  text,
  onSeek,
  onEdit
}: {
  text: string
  onSeek?: (ms: number) => void
  onEdit: () => void
}): React.JSX.Element {
  return (
    <div
      className="notes-view"
      role="button"
      tabIndex={0}
      title="Click to edit"
      onClick={onEdit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') onEdit()
      }}
    >
      {text.split('\n').map((line, i) => {
        const ms = stampMs(line)
        const m = STAMP.exec(line)
        if (ms === null || !m) {
          return (
            <div className="notes-line" key={i}>
              {line || ' '}
            </div>
          )
        }
        return (
          <div className="notes-line" key={i}>
            <button
              className="note-stamp"
              disabled={!onSeek}
              title={onSeek ? 'Play from here' : undefined}
              onClick={(e) => {
                e.stopPropagation()
                onSeek?.(ms)
              }}
            >
              {m[0].trim()}
            </button>{' '}
            {line.slice(m[0].length)}
          </div>
        )
      })}
    </div>
  )
}
