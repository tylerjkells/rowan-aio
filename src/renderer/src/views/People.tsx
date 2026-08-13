import { useEffect, useRef, useState } from 'react'
import type { PersonDetails, PersonProfile, PersonSummary } from '../../../shared/types'
import { BackIcon, DueEditor, formatWhen, isOverdue, useConfirm } from '../ui'

const keyOf = (name: string): string => name.trim().toLowerCase()
const byName = (a: PersonSummary, b: PersonSummary): number => a.name.localeCompare(b.name)

/** "Title · Department", whichever parts exist */
function roleLine(d?: PersonDetails): string {
  return [d?.title, d?.department].filter(Boolean).join(' · ')
}

// ---------------------------------------------------------------------------
// Add/edit dialog
// ---------------------------------------------------------------------------

function PersonEditDialog({
  person,
  people,
  onClose
}: {
  /** null = adding a brand-new person */
  person: PersonSummary | null
  people: PersonSummary[]
  onClose: (changed: boolean) => void
}): React.JSX.Element {
  const ref = useRef<HTMLDialogElement>(null)
  const d = person?.details
  const [name, setName] = useState(person?.name ?? '')
  const [title, setTitle] = useState(d?.title ?? '')
  const [department, setDepartment] = useState(d?.department ?? '')
  const [email, setEmail] = useState(d?.email ?? '')
  const [phone, setPhone] = useState(d?.phone ?? '')
  const [office, setOffice] = useState(d?.office ?? '')
  const [reportsTo, setReportsTo] = useState(d?.reportsTo ?? '')
  const [notes, setNotes] = useState(d?.notes ?? '')
  const [confirmRemove, setConfirmRemove] = useState(false)

  useEffect(() => {
    ref.current?.showModal()
  }, [])

  const managers = people
    .filter((p) => keyOf(p.name) !== keyOf(person?.name ?? name))
    .sort(byName)

  async function save(e: React.FormEvent): Promise<void> {
    e.preventDefault()
    const target = (person?.name ?? name).trim()
    if (!target) return
    await window.scribe.people.setDetails(target, {
      title,
      department,
      email,
      phone,
      office,
      reportsTo,
      notes
    })
    onClose(true)
  }

  async function remove(): Promise<void> {
    if (!person) return
    if (!confirmRemove) {
      setConfirmRemove(true)
      return
    }
    await window.scribe.people.remove(person.name)
    onClose(true)
  }

  const field = (
    label: string,
    value: string,
    set: (v: string) => void,
    type = 'text'
  ): React.JSX.Element => (
    <label className="pd-field">
      <span>{label}</span>
      <input className="text-input" type={type} value={value} onChange={(e) => set(e.target.value)} />
    </label>
  )

  return (
    <dialog
      ref={ref}
      className="confirm person-edit"
      onClose={() => onClose(false)}
      onClick={(e) => {
        if (e.target === ref.current) onClose(false)
      }}
    >
      <form onSubmit={save}>
        <h3>{person ? person.name : 'Add person'}</h3>
        {!person && (
          <label className="pd-field">
            <span>Name</span>
            <input
              className="text-input"
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoFocus
              required
            />
          </label>
        )}
        <div className="pd-grid">
          {field('Title', title, setTitle)}
          {field('Department', department, setDepartment)}
          {field('Email', email, setEmail, 'email')}
          {field('Phone', phone, setPhone, 'tel')}
          {field('Office', office, setOffice)}
          <label className="pd-field">
            <span>Reports to</span>
            <select
              className="text-input"
              value={reportsTo}
              onChange={(e) => setReportsTo(e.target.value)}
            >
              <option value="">—</option>
              {managers.map((m) => (
                <option key={m.name} value={m.name}>
                  {m.name}
                </option>
              ))}
              {reportsTo && !managers.some((m) => m.name === reportsTo) && (
                <option value={reportsTo}>{reportsTo}</option>
              )}
            </select>
          </label>
        </div>
        <label className="pd-field">
          <span>Notes</span>
          <textarea
            className="text-input pd-notes"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={2}
          />
        </label>
        <div className="confirm-actions">
          {person && person.meetingCount === 0 && (
            <button type="button" className="btn btn-danger pd-remove" onClick={remove}>
              {confirmRemove ? 'Really remove?' : 'Remove'}
            </button>
          )}
          <button type="button" className="btn" onClick={() => onClose(false)}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary">
            Save
          </button>
        </div>
      </form>
    </dialog>
  )
}

// ---------------------------------------------------------------------------
// Org chart
// ---------------------------------------------------------------------------

function OrgChart({
  people,
  onOpen
}: {
  people: PersonSummary[]
  onOpen: (name: string) => void
}): React.JSX.Element {
  const byKey = new Map(people.map((p) => [keyOf(p.name), p]))
  const children = new Map<string, PersonSummary[]>()
  const roots: PersonSummary[] = []
  for (const p of people) {
    const mgr = p.details?.reportsTo ? byKey.get(keyOf(p.details.reportsTo)) : undefined
    if (mgr && keyOf(mgr.name) !== keyOf(p.name)) {
      const arr = children.get(keyOf(mgr.name)) ?? []
      arr.push(p)
      children.set(keyOf(mgr.name), arr)
    } else {
      roots.push(p)
    }
  }

  const rendered = new Set<string>()
  const node = (p: PersonSummary): React.JSX.Element | null => {
    if (rendered.has(keyOf(p.name))) return null // reporting-line cycle guard
    rendered.add(keyOf(p.name))
    const kids = (children.get(keyOf(p.name)) ?? []).sort(byName)
    return (
      <div className="org-node" key={p.name}>
        <button className="org-card" onClick={() => onOpen(p.name)}>
          <span className="org-name">{p.name}</span>
          {roleLine(p.details) && <span className="org-role">{roleLine(p.details)}</span>}
        </button>
        {kids.length > 0 && <div className="org-children">{kids.map(node)}</div>}
      </div>
    )
  }

  const trees = roots.sort(byName).map(node)
  // anyone trapped in a cycle still gets drawn, as a root
  const leftovers = people.filter((p) => !rendered.has(keyOf(p.name))).map(node)

  return (
    <div className="org-chart">
      {trees}
      {leftovers}
      {people.some((p) => !p.details?.reportsTo) && people.length > 1 && (
        <p className="today-quiet org-hint">
          Set “Reports to” on a person to place them in the chart.
        </p>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// People page
// ---------------------------------------------------------------------------

type PeopleMode = 'list' | 'chart'

export function PeopleView({
  onOpenPerson
}: {
  onOpenPerson: (name: string) => void
}): React.JSX.Element {
  const [people, setPeople] = useState<PersonSummary[]>([])
  const [loaded, setLoaded] = useState(false)
  const [mode, setMode] = useState<PeopleMode>(
    () => (localStorage.getItem('peopleView') as PeopleMode) || 'list'
  )
  const [editing, setEditing] = useState<PersonSummary | 'new' | null>(null)

  function load(): void {
    window.scribe.people.list().then((list) => {
      setPeople(list)
      setLoaded(true)
    })
  }
  useEffect(load, [])

  function switchMode(m: PeopleMode): void {
    setMode(m)
    localStorage.setItem('peopleView', m)
  }

  const dialog =
    editing !== null ? (
      <PersonEditDialog
        person={editing === 'new' ? null : editing}
        people={people}
        onClose={(changed) => {
          setEditing(null)
          if (changed) load()
        }}
      />
    ) : null

  if (loaded && people.length === 0) {
    return (
      <>
        {dialog}
        <div className="empty-state">
          <h2>Nobody yet</h2>
          <p>
            People collect here from your meetings — action-item owners, named speakers, calendar
            attendees — or add them yourself to build the org directory.
          </p>
          <button className="btn btn-primary" onClick={() => setEditing('new')}>
            Add person
          </button>
        </div>
      </>
    )
  }

  const row = (p: PersonSummary): React.JSX.Element => (
    <button key={p.name} className="meeting-row compact" onClick={() => onOpenPerson(p.name)}>
      <span className="meeting-row-title">
        {p.name}
        {roleLine(p.details) && <span className="person-sub">{roleLine(p.details)}</span>}
      </span>
      <span className="meeting-row-meta">
        {p.openItems > 0 && (
          <span className="person-open">
            {p.openItems} open {p.openItems === 1 ? 'item' : 'items'}
          </span>
        )}
        {p.meetingCount > 0 && (
          <span>
            {p.meetingCount} {p.meetingCount === 1 ? 'meeting' : 'meetings'}
          </span>
        )}
      </span>
    </button>
  )

  return (
    <>
      {dialog}
      <div className="page-head">
        <h1>People</h1>
        <div className="page-head-tools">
          <span className="count-note">
            {people.length} {people.length === 1 ? 'person' : 'people'}
          </span>
          <div className="mode-toggle view-toggle" role="radiogroup" aria-label="View">
            <button
              className={mode === 'list' ? 'active' : ''}
              role="radio"
              aria-checked={mode === 'list'}
              onClick={() => switchMode('list')}
            >
              List
            </button>
            <button
              className={mode === 'chart' ? 'active' : ''}
              role="radio"
              aria-checked={mode === 'chart'}
              onClick={() => switchMode('chart')}
            >
              Org chart
            </button>
          </div>
          <button className="btn" onClick={() => setEditing('new')}>
            Add person
          </button>
        </div>
      </div>
      {mode === 'list' ? (
        <div className="meeting-list">{people.map(row)}</div>
      ) : (
        <OrgChart people={people} onOpen={onOpenPerson} />
      )}
    </>
  )
}

// ---------------------------------------------------------------------------
// Person page
// ---------------------------------------------------------------------------

export function PersonView({
  name,
  onBack,
  onOpenMeeting,
  onOpenPerson
}: {
  name: string
  onBack: () => void
  onOpenMeeting: (id: string) => void
  onOpenPerson: (name: string) => void
}): React.JSX.Element {
  const [profile, setProfile] = useState<PersonProfile | null>(null)
  const [showDone, setShowDone] = useState(false)
  const [people, setPeople] = useState<PersonSummary[]>([])
  const [editing, setEditing] = useState(false)
  const [confirmDialog, confirm] = useConfirm()

  function load(): void {
    window.scribe.people.profile(name).then(setProfile)
    window.scribe.people.list().then(setPeople)
  }
  useEffect(load, [name]) // eslint-disable-line react-hooks/exhaustive-deps

  async function mergeInto(target: string): Promise<void> {
    if (!profile) return
    const ok = await confirm({
      title: `Merge "${profile.name}" into "${target}"?`,
      body: `Meetings and action items attributed to "${profile.name}" will count as ${
        target === 'Me' ? 'yours' : `"${target}"`
      } from now on.`,
      confirmLabel: 'Merge'
    })
    if (!ok) return
    await window.scribe.people.merge(profile.name, target)
    onBack()
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const target = e.target as HTMLElement
      if (document.querySelector('dialog[open]') || document.querySelector('.askw-panel')) return
      if (e.key === 'Escape' && target.tagName !== 'INPUT' && target.tagName !== 'TEXTAREA') {
        onBack()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onBack])

  if (!profile) return <></>

  const open = profile.items.filter((i) => !i.done)
  const done = profile.items.filter((i) => i.done)
  const visibleItems = showDone ? [...open, ...done] : open

  async function toggle(meetingId: string, index: number): Promise<void> {
    await window.scribe.actions.toggle(meetingId, index)
    load()
  }

  async function setDue(meetingId: string, index: number, iso: string | null): Promise<void> {
    await window.scribe.actions.setDue(meetingId, index, iso)
    load()
  }

  const mergeTargets = ['Me', ...people.map((p) => p.name)].filter(
    (t) => t.toLowerCase() !== profile.name.toLowerCase()
  )

  const d = profile.details
  const reports = people
    .filter((p) => p.details?.reportsTo && keyOf(p.details.reportsTo) === keyOf(profile.name))
    .sort(byName)
  const summary = people.find((p) => keyOf(p.name) === keyOf(profile.name)) ?? {
    name: profile.name,
    meetingCount: profile.meetings.length,
    openItems: open.length,
    details: d
  }

  return (
    <div className="main-narrow">
      {confirmDialog}
      {editing && (
        <PersonEditDialog
          person={summary}
          people={people}
          onClose={(changed) => {
            setEditing(false)
            if (changed) load()
          }}
        />
      )}
      <div className="detail-head">
        <button className="back-link" onClick={onBack}>
          <BackIcon /> All people
        </button>
        <h1 className="person-name">{profile.name}</h1>
        {roleLine(d) && <div className="person-role">{roleLine(d)}</div>}
        <div className="detail-meta">
          <span>
            {profile.meetings.length} {profile.meetings.length === 1 ? 'meeting' : 'meetings'}{' '}
            together
          </span>
          {open.length > 0 && (
            <span>
              {open.length} open {open.length === 1 ? 'item' : 'items'}
            </span>
          )}
          <button className="btn btn-ghost" onClick={() => setEditing(true)}>
            Edit details
          </button>
          <select
            className="merge-select"
            value=""
            onChange={(e) => e.target.value && mergeInto(e.target.value)}
            aria-label={`Merge ${profile.name} into another person`}
            title="Same person under a different name? Merge them."
          >
            <option value="">Merge into…</option>
            {mergeTargets.map((t) => (
              <option value={t} key={t}>
                {t === 'Me' ? 'Me (this is me)' : t}
              </option>
            ))}
          </select>
        </div>
      </div>

      {(d?.email || d?.phone || d?.office || d?.reportsTo || reports.length > 0 || d?.notes) && (
        <section className="section person-card">
          <div className="person-contact">
            {d?.email && (
              <a href={`mailto:${d.email}`} target="_blank" rel="noreferrer">
                {d.email}
              </a>
            )}
            {d?.phone && (
              <a href={`tel:${d.phone}`} target="_blank" rel="noreferrer">
                {d.phone}
              </a>
            )}
            {d?.office && <span>{d.office}</span>}
          </div>
          {d?.reportsTo && (
            <div className="person-line">
              Reports to{' '}
              <button className="person-chip" onClick={() => onOpenPerson(d.reportsTo!)}>
                {d.reportsTo}
              </button>
            </div>
          )}
          {reports.length > 0 && (
            <div className="person-line">
              Direct reports:{' '}
              {reports.map((r) => (
                <button key={r.name} className="person-chip" onClick={() => onOpenPerson(r.name)}>
                  {r.name}
                </button>
              ))}
            </div>
          )}
          {d?.notes && <p className="person-notes">{d.notes}</p>}
        </section>
      )}

      <section className="section">
        <div className="person-section-head">
          <div className="card-subhead">They own</div>
          {done.length > 0 && (
            <button className="btn btn-ghost person-showdone" onClick={() => setShowDone(!showDone)}>
              {showDone ? 'Hide done' : `Show ${done.length} done`}
            </button>
          )}
        </div>
        {visibleItems.length === 0 ? (
          <p className="today-quiet">Nothing on their plate from your meetings.</p>
        ) : (
          <div className="rollup-list">
            {visibleItems.map((item) => (
              <div
                className={`rollup-item ${item.done ? 'done' : ''}`}
                key={`${item.meetingId}-${item.index}`}
              >
                <input
                  type="checkbox"
                  className="rollup-check"
                  checked={item.done}
                  onChange={() => toggle(item.meetingId, item.index)}
                  aria-label={`Mark "${item.task}" ${item.done ? 'open' : 'done'}`}
                />
                <div className="rollup-body">
                  <span className="rollup-task">{item.task}</span>
                  <span className="rollup-meta">
                    <DueEditor
                      due={item.due}
                      dueDate={item.dueDate}
                      edited={item.dueEdited}
                      overdue={isOverdue(item)}
                      onSave={(iso) => setDue(item.meetingId, item.index, iso)}
                    />
                    <button className="rollup-source" onClick={() => onOpenMeeting(item.meetingId)}>
                      {item.meetingTitle} · {formatWhen(item.createdAt)}
                    </button>
                  </span>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {profile.myCommitments.length > 0 && (
        <section className="section">
          <div className="card-subhead">You owe, from meetings together</div>
          <div className="rollup-list">
            {profile.myCommitments.map((item) => (
              <div className="rollup-item" key={`${item.meetingId}-${item.index}`}>
                <input
                  type="checkbox"
                  className="rollup-check"
                  checked={false}
                  onChange={() => toggle(item.meetingId, item.index)}
                  aria-label={`Mark "${item.task}" done`}
                />
                <div className="rollup-body">
                  <span className="rollup-task">{item.task}</span>
                  <span className="rollup-meta">
                    <DueEditor
                      due={item.due}
                      dueDate={item.dueDate}
                      edited={item.dueEdited}
                      overdue={isOverdue(item)}
                      onSave={(iso) => setDue(item.meetingId, item.index, iso)}
                    />
                    <button className="rollup-source" onClick={() => onOpenMeeting(item.meetingId)}>
                      {item.meetingTitle} · {formatWhen(item.createdAt)}
                    </button>
                  </span>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      <section className="section">
        <div className="card-subhead">Meetings together</div>
        {profile.meetings.length === 0 ? (
          <p className="today-quiet">No meetings together yet.</p>
        ) : (
          <div className="meeting-list">
            {profile.meetings.map((m) => (
              <button
                key={m.id}
                className="meeting-row compact"
                onClick={() => onOpenMeeting(m.id)}
                title={m.tldr}
              >
                <span className="meeting-row-title">{m.title}</span>
                <span className="meeting-row-meta">
                  <span>{formatWhen(m.createdAt)}</span>
                </span>
              </button>
            ))}
          </div>
        )}
      </section>
    </div>
  )
}
