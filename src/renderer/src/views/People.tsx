import { useEffect, useRef, useState } from 'react'
import type {
  DirectoryImportScan,
  PersonDetails,
  PersonProfile,
  PersonSummary,
  ToolboxQuery
} from '../../../shared/types'
import { BackIcon, DueEditor, formatWhen, isOverdue, useConfirm } from '../ui'
import { DIRECTORY_SQL } from '../directoryQuery'

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
    const target = name.trim()
    if (!target) return
    if (person && target !== person.name) {
      await window.scribe.people.rename(person.name, target)
    }
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
        <label className="pd-field">
          <span>Name</span>
          <input
            className="text-input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoFocus={!person}
            required
            title={
              person
                ? 'Renaming keeps their meeting history; renaming to an existing person merges them.'
                : undefined
            }
          />
        </label>
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
// CSV import preview
// ---------------------------------------------------------------------------

function ImportDialog({
  scan,
  onClose
}: {
  scan: DirectoryImportScan
  onClose: (imported: boolean) => void
}): React.JSX.Element {
  const ref = useRef<HTMLDialogElement>(null)
  const [busy, setBusy] = useState(false)
  const [fillExisting, setFillExisting] = useState(false)

  useEffect(() => {
    ref.current?.showModal()
  }, [])

  async function apply(): Promise<void> {
    setBusy(true)
    await window.scribe.people.importApply(scan.rows, { fillExisting })
    onClose(true)
  }

  const fresh = scan.rows.filter((r) => !r.existing)
  const already = scan.rows.filter((r) => r.existing)
  // matched under another name: listed, so a wrong match is easy to spot
  const renamed = already.filter((r) => r.existing!.toLowerCase() !== r.name.toLowerCase())
  const count = fresh.length + (fillExisting ? already.filter((r) => r.existing !== 'Me').length : 0)
  const preview = fresh.slice(0, 8)

  return (
    <dialog
      ref={ref}
      className="confirm person-edit"
      onClose={() => onClose(false)}
      onClick={(e) => {
        if (e.target === ref.current && !busy) onClose(false)
      }}
    >
      <h3>Import from {scan.file}</h3>
      {scan.error ? (
        <p>{scan.error}</p>
      ) : (
        <>
          <p>
            {fresh.length} new · {already.length} already in People
            {scan.skipped > 0 && <> · {scan.skipped} rows skipped (missing or unusable name)</>}
          </p>
          <div className="import-mapping">
            {Object.entries(scan.mapped).map(([field, header]) => (
              <span className="import-map-chip" key={field}>
                {field} ← {header}
              </span>
            ))}
          </div>
          {fresh.length > 0 ? (
            <div className="import-preview">
              {preview.map((r) => (
                <div className="import-preview-row" key={r.name}>
                  <span className="import-preview-name">{r.name}</span>
                  <span className="import-preview-sub">
                    {[r.details.title, r.details.department, r.details.reportsTo && `→ ${r.details.reportsTo}`]
                      .filter(Boolean)
                      .join(' · ')}
                  </span>
                </div>
              ))}
              {fresh.length > preview.length && (
                <div className="import-preview-more">…and {fresh.length - preview.length} more</div>
              )}
            </div>
          ) : (
            <p className="tk-hint">Everyone in this file is already in People.</p>
          )}
          {renamed.length > 0 && (
            <p className="tk-hint">
              Already here under another name:{' '}
              {renamed
                .slice(0, 6)
                .map((r) => `${r.name} is ${r.existing === 'Me' ? 'you' : r.existing}`)
                .join(', ')}
              {renamed.length > 6 && `, and ${renamed.length - 6} more`}.
            </p>
          )}
          {already.length > 0 && (
            <div className="import-mode" role="radiogroup" aria-label="People already here">
              <label>
                <input type="radio" checked={!fillExisting} onChange={() => setFillExisting(false)} />
                Only add the new people. Everyone already here stays exactly as they are.
              </label>
              <label>
                <input type="radio" checked={fillExisting} onChange={() => setFillExisting(true)} />
                Also fill in blank details for people already here. Nothing already filled in changes.
              </label>
            </div>
          )}
        </>
      )}
      <div className="confirm-actions">
        <button className="btn" onClick={() => onClose(false)} disabled={busy}>
          {count > 0 ? 'Cancel' : 'Close'}
        </button>
        {!scan.error && count > 0 && (
          <button className="btn btn-primary" onClick={apply} disabled={busy}>
            {busy
              ? 'Importing…'
              : fillExisting
                ? `Import ${count}`
                : `Add ${count} ${count === 1 ? 'person' : 'people'}`}
          </button>
        )}
      </div>
    </dialog>
  )
}

// ---------------------------------------------------------------------------
// Update from ODS: the steps for refreshing the directory, with the query to
// run. The query itself lives in Toolbox → SQL; this remembers which saved
// query it is, so it's never more than a click away when new people start.
// ---------------------------------------------------------------------------

const DIRECTORY_QUERY = 'People directory'
/** the query that ships with the app, listed ahead of the saved ones */
const BUILT_IN: ToolboxQuery = {
  id: 'built-in',
  name: 'Rowan Online and Vijay’s team (built in)',
  sql: DIRECTORY_SQL,
  addedAt: ''
}
/** a saved query whose name says it's the directory export: picked ahead of the built-in one */
const looksLikeDirectory = (q: ToolboxQuery): boolean =>
  /directory|people|employee|staff|org ?chart|roster/i.test(q.name)

function OdsDialog({
  onClose,
  onChooseCsv
}: {
  onClose: () => void
  onChooseCsv: () => void
}): React.JSX.Element {
  const ref = useRef<HTMLDialogElement>(null)
  const [queries, setQueries] = useState<ToolboxQuery[] | null>(null)
  const [chosen, setChosen] = useState(() => localStorage.getItem('peopleQueryId') ?? '')
  const [pasting, setPasting] = useState(false)
  const [draft, setDraft] = useState('')
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    ref.current?.showModal()
    window.scribe.toolbox.get().then((d) => {
      setQueries(d.queries)
      setChosen((id) =>
        id === BUILT_IN.id || d.queries.some((q) => q.id === id)
          ? id
          : (d.queries.find(looksLikeDirectory)?.id ?? BUILT_IN.id)
      )
    })
  }, [])

  function pick(id: string): void {
    setChosen(id)
    setCopied(false)
    localStorage.setItem('peopleQueryId', id)
  }

  async function saveDraft(): Promise<void> {
    if (!draft.trim()) return
    const d = await window.scribe.toolbox.saveQuery({
      name: DIRECTORY_QUERY,
      sql: draft,
      note: 'The directory export for People → Update from ODS.'
    })
    setQueries(d.queries)
    // a new query goes to the top of the list
    pick(d.queries[0].id)
    setPasting(false)
    setDraft('')
  }

  async function copy(q: ToolboxQuery): Promise<void> {
    await navigator.clipboard.writeText(q.sql)
    pick(q.id)
    setCopied(true)
  }

  const options = queries ? [BUILT_IN, ...queries] : []
  const query = options.find((q) => q.id === chosen) ?? BUILT_IN

  return (
    <dialog
      ref={ref}
      className="confirm tk-dialog"
      onClose={onClose}
      onClick={(e) => {
        if (e.target === ref.current) onClose()
      }}
    >
      <h3>Update people from ODS</h3>
      <ol className="tk-steps">
        <li>
          {pasting
            ? 'Run your directory query in ODS. Paste it below once and it’s kept here for next time.'
            : 'Copy the directory query below and run it in ODS.'}
        </li>
        <li>
          Export the results as a CSV file. Name is the only column it needs; Title, Department,
          Email, Phone, Manager, Office and Notes fill in the rest, in any order.
        </li>
        <li>Choose that file here. You&apos;ll see a preview before anything changes.</li>
      </ol>

      {queries === null ? (
        <p className="tk-hint">Loading your saved queries…</p>
      ) : pasting ? (
        <>
          <label className="pd-field">
            <span>Paste the query you run for the directory export</span>
            <textarea
              className="text-input sql-input ods-paste"
              spellCheck={false}
              placeholder="SELECT …"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              autoFocus
            />
          </label>
          <p className="tk-hint">
            It&apos;s saved in Toolbox → SQL as “{DIRECTORY_QUERY}” and shows up here from then on.
          </p>
          <div className="ods-query-bar">
            <button className="btn" onClick={saveDraft} disabled={!draft.trim()}>
              Save query
            </button>
            <button className="link-btn" onClick={() => setPasting(false)}>
              Pick one instead
            </button>
          </div>
        </>
      ) : (
        <>
          <div className="ods-query-bar">
            <select
              className="text-input ods-select"
              value={query.id}
              onChange={(e) => pick(e.target.value)}
              aria-label="Directory query"
            >
              {options.map((q) => (
                <option key={q.id} value={q.id}>
                  {q.name}
                </option>
              ))}
            </select>
            <button className="btn" onClick={() => copy(query)}>
              {copied ? 'Copied' : 'Copy SQL'}
            </button>
            <button className="link-btn" onClick={() => setPasting(true)}>
              Paste a new one
            </button>
          </div>
          <pre className="sql-block ods-sql">{query.sql}</pre>
        </>
      )}

      <p className="tk-hint">
        Only people who aren&apos;t in People yet are added; everyone already here stays as they are.
        Nobody is removed: for anyone who has left, open their page and use Edit details → Remove.
      </p>
      <div className="confirm-actions">
        <button className="btn" onClick={onClose}>
          Cancel
        </button>
        <button className="btn btn-primary" onClick={onChooseCsv}>
          Choose CSV…
        </button>
      </div>
    </dialog>
  )
}

// ---------------------------------------------------------------------------
// Org chart
// ---------------------------------------------------------------------------

function OrgChart({
  people,
  onOpen,
  focusName,
  setFocusName
}: {
  people: PersonSummary[]
  onOpen: (name: string) => void
  focusName: string | null
  setFocusName: (name: string) => void
}): React.JSX.Element {
  const [showUnplaced, setShowUnplaced] = useState(false)
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
  const kidsOf = (p: PersonSummary): PersonSummary[] =>
    (children.get(keyOf(p.name)) ?? []).sort(byName)
  const managerOf = (p: PersonSummary): PersonSummary | undefined => {
    const mgr = p.details?.reportsTo ? byKey.get(keyOf(p.details.reportsTo)) : undefined
    return mgr && keyOf(mgr.name) !== keyOf(p.name) ? mgr : undefined
  }

  // everyone under a person, not just direct reports (cycle-safe)
  const totalCache = new Map<string, number>()
  const totalReports = (p: PersonSummary, seen = new Set<string>()): number => {
    const key = keyOf(p.name)
    if (totalCache.has(key)) return totalCache.get(key)!
    if (seen.has(key)) return 0
    seen.add(key)
    const n = kidsOf(p).reduce((sum, k) => sum + 1 + totalReports(k, seen), 0)
    totalCache.set(key, n)
    return n
  }

  const treeRoots = roots.filter((p) => kidsOf(p).length > 0)
  const unplaced = roots.filter((p) => kidsOf(p).length === 0).sort(byName)

  // default focus: the top of the biggest tree
  const defaultFocus =
    [...treeRoots].sort((a, b) => totalReports(b) - totalReports(a))[0] ?? people[0]
  const focus = (focusName && byKey.get(keyOf(focusName))) || defaultFocus
  if (!focus) return <p className="today-quiet">Nobody in the directory yet.</p>

  // chain of managers above the focused person
  const ancestors: PersonSummary[] = []
  const seen = new Set<string>([keyOf(focus.name)])
  for (let m = managerOf(focus); m && !seen.has(keyOf(m.name)); m = managerOf(m)) {
    seen.add(keyOf(m.name))
    ancestors.unshift(m)
  }

  const manager = managerOf(focus)
  const siblings = manager ? kidsOf(manager) : [...treeRoots].sort(byName)
  const reports = kidsOf(focus)
  const focusTotal = totalReports(focus)

  const reportCard = (p: PersonSummary): React.JSX.Element => {
    const n = totalReports(p)
    return (
      <button className="orgb-card" key={p.name} onClick={() => setFocusName(p.name)}>
        <span className="orgb-card-main">
          <span className="org-name">{p.name}</span>
          {roleLine(p.details) && <span className="org-role">{roleLine(p.details)}</span>}
          {p.details?.office && <span className="orgb-card-office">{p.details.office}</span>}
        </span>
        {n > 0 && <span className="orgb-count">{n} ▾</span>}
      </button>
    )
  }

  return (
    <div className="orgb">
      {ancestors.map((a) => (
        <div className="orgb-anc-wrap" key={a.name}>
          <button className="orgb-anc" onClick={() => setFocusName(a.name)}>
            <span className="orgb-card-main">
              <span className="org-name">{a.name}</span>
              {roleLine(a.details) && <span className="org-role">{roleLine(a.details)}</span>}
            </span>
            <span className="orgb-count">{totalReports(a)}</span>
          </button>
          <span className="orgb-connector" aria-hidden="true" />
        </div>
      ))}

      {siblings.length > 1 && (
        <div className="orgb-sibs-block">
          {manager && (
            <div className="orgb-sibs-label">
              People reporting to <strong>{manager.name}</strong>
            </div>
          )}
          <div className="orgb-sibs">
            {siblings.map((s) => {
              const n = totalReports(s)
              return (
                <button
                  key={s.name}
                  className={`orgb-chip ${keyOf(s.name) === keyOf(focus.name) ? 'active' : ''}`}
                  onClick={() => setFocusName(s.name)}
                >
                  {s.name}
                  {n > 0 && <span className="orgb-chip-count">{n}</span>}
                </button>
              )
            })}
          </div>
        </div>
      )}

      <div className="orgb-focus">
        <div className="orgb-focus-main">
          <span className="orgb-focus-name">{focus.name}</span>
          {roleLine(focus.details) && <span className="orgb-focus-role">{roleLine(focus.details)}</span>}
          {focus.details?.office && <span className="orgb-card-office">{focus.details.office}</span>}
        </div>
        <div className="orgb-focus-side">
          <button className="btn btn-primary" onClick={() => onOpen(focus.name)}>
            Open profile
          </button>
          {focusTotal > 0 && (
            <span className="orgb-focus-counts">
              {focusTotal} {focusTotal === 1 ? 'report' : 'reports'}
              {reports.length !== focusTotal && <> · {reports.length} direct</>}
            </span>
          )}
        </div>
      </div>

      {reports.length > 0 ? (
        <>
          <div className="orgb-divider">
            <span>
              People reporting to <strong>{focus.name}</strong>
            </span>
          </div>
          <div className="orgb-reports">{reports.map(reportCard)}</div>
        </>
      ) : (
        <p className="today-quiet orgb-none">No one reports to {focus.name}.</p>
      )}

      {unplaced.length > 0 && (
        <div className="org-unplaced-block">
          <button className="cu-section-head" onClick={() => setShowUnplaced(!showUnplaced)}>
            <span className={`cu-section-chevron ${showUnplaced ? 'open' : ''}`}>›</span>
            <span className="card-subhead">
              Not placed in the chart · {unplaced.length} · set “Reports to” to place them
            </span>
          </button>
          {showUnplaced && <div className="orgb-reports">{unplaced.map(reportCard)}</div>}
        </div>
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
  const [importScan, setImportScan] = useState<DirectoryImportScan | null>(null)
  const [updating, setUpdating] = useState(false)
  const [query, setQuery] = useState('')
  const [chartFocus, setChartFocus] = useState<string | null>(null)

  function load(): void {
    window.scribe.people.list().then((list) => {
      setPeople(list)
      setLoaded(true)
    })
  }
  useEffect(load, [])

  async function startImport(): Promise<void> {
    const scan = await window.scribe.people.importScan()
    if (scan) {
      setUpdating(false)
      setImportScan(scan)
    }
  }

  const q = query.trim().toLowerCase()
  const matchText = (p: PersonSummary): string =>
    [p.name, p.details?.title, p.details?.department, p.details?.email]
      .filter(Boolean)
      .join(' ')
      .toLowerCase()
  const nameFirst = (a: PersonSummary, b: PersonSummary): number =>
    Number(b.name.toLowerCase().startsWith(q)) - Number(a.name.toLowerCase().startsWith(q))
  const allMatches = q ? people.filter((p) => matchText(p).includes(q)).sort(nameFirst) : people
  // the chart dropdown stays short; the list shows every match
  const matches = mode === 'chart' ? allMatches.slice(0, 8) : allMatches

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
    ) : importScan !== null ? (
      <ImportDialog
        scan={importScan}
        onClose={(imported) => {
          setImportScan(null)
          if (imported) load()
        }}
      />
    ) : updating ? (
      <OdsDialog onClose={() => setUpdating(false)} onChooseCsv={startImport} />
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
          <div className="empty-state-actions">
            <button className="btn btn-primary" onClick={() => setEditing('new')}>
              Add person
            </button>
            <button className="btn" onClick={() => setUpdating(true)}>
              Import from ODS
            </button>
          </div>
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
          <div className="people-search">
            <input
              className="text-input search-input"
              type="search"
              placeholder="Search people"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              aria-label="Search people"
            />
            {mode === 'chart' && query.trim() && (
              <div className="people-search-results">
                {matches.length === 0 ? (
                  <div className="people-search-empty">No matches</div>
                ) : (
                  matches.map((p) => (
                    <button
                      key={p.name}
                      className="people-search-row"
                      onClick={() => {
                        setChartFocus(p.name)
                        setQuery('')
                      }}
                    >
                      <span className="org-name">{p.name}</span>
                      {roleLine(p.details) && (
                        <span className="org-role">{roleLine(p.details)}</span>
                      )}
                    </button>
                  ))
                )}
              </div>
            )}
          </div>
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
          <button
            className="btn btn-ghost"
            onClick={() => setUpdating(true)}
            title="Bring in new people and refresh everyone's details: the query to run, then the CSV it exports"
          >
            Update from ODS
          </button>
        </div>
      </div>
      {mode === 'list' ? (
        <div className="meeting-list">
          {(query.trim() ? matches : people).map(row)}
          {query.trim() && matches.length === 0 && (
            <p className="today-quiet">No one matches “{query.trim()}”.</p>
          )}
        </div>
      ) : (
        <OrgChart
          people={people}
          onOpen={onOpenPerson}
          focusName={chartFocus}
          setFocusName={setChartFocus}
        />
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
