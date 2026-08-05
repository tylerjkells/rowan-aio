import { useEffect, useState } from 'react'
import type { SeriesData } from '../../../shared/types'
import { BackIcon, formatDuration, formatWhen, isOverdue } from '../ui'

/** the running narrative of one recurring meeting */
export function SeriesView({
  title,
  onBack,
  onOpenMeeting
}: {
  title: string
  onBack: () => void
  onOpenMeeting: (id: string) => void
}): React.JSX.Element {
  const [series, setSeries] = useState<SeriesData | null>(null)

  function load(): void {
    window.scribe.series.get(title).then(setSeries)
  }
  useEffect(load, [title]) // eslint-disable-line react-hooks/exhaustive-deps

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

  if (!series) return <></>

  const totalMs = series.occurrences.reduce((sum, m) => sum + m.durationMs, 0)

  async function toggle(meetingId: string, index: number): Promise<void> {
    await window.scribe.actions.toggle(meetingId, index)
    load()
  }

  return (
    <div className="main-narrow">
      <div className="detail-head">
        <button className="back-link" onClick={onBack}>
          <BackIcon /> Back
        </button>
        <h1 className="person-name">{series.title}</h1>
        <div className="detail-meta">
          <span>
            {series.occurrences.length}{' '}
            {series.occurrences.length === 1 ? 'meeting' : 'meetings'}
          </span>
          <span>{formatDuration(totalMs)} total</span>
          {series.occurrences.length > 0 && (
            <span>
              since {formatWhen(series.occurrences[series.occurrences.length - 1].createdAt)}
            </span>
          )}
        </div>
      </div>

      {series.openActions.length > 0 && (
        <section className="section">
          <div className="card-subhead">Still open across the series</div>
          <div className="rollup-list">
            {series.openActions.map((item) => (
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
                    {item.owners.length > 0 && (
                      <span className="owner-btn series-owner">{item.owners.join(' + ')}</span>
                    )}
                    {item.due && (
                      <span className={`action-due ${isOverdue(item) ? 'overdue' : ''}`}>
                        {item.due}
                      </span>
                    )}
                    <button className="rollup-source" onClick={() => onOpenMeeting(item.meetingId)}>
                      {formatWhen(item.createdAt)}
                    </button>
                  </span>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {series.decisions.length > 0 && (
        <section className="section">
          <div className="card-subhead">Decisions over time</div>
          <div className="series-timeline">
            {series.decisions.map((d) => (
              <div className="series-entry" key={d.meetingId}>
                <button className="series-date" onClick={() => onOpenMeeting(d.meetingId)}>
                  {formatWhen(d.createdAt)}
                </button>
                <ul className="point-list series-points">
                  {d.items.map((item, i) => (
                    <li key={i}>{item}</li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </section>
      )}

      <section className="section">
        <div className="card-subhead">All occurrences</div>
        <div className="meeting-list">
          {series.occurrences.map((m) => (
            <button
              key={m.id}
              className="meeting-row compact"
              onClick={() => onOpenMeeting(m.id)}
              title={m.tldr}
            >
              <span className="meeting-row-title">{formatWhen(m.createdAt)}</span>
              <span className="meeting-row-meta">
                <span>{formatDuration(m.durationMs)}</span>
              </span>
            </button>
          ))}
        </div>
      </section>
    </div>
  )
}
