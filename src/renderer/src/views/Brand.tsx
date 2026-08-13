import { useEffect, useRef, useState } from 'react'
import type { BrandColor, BrandData } from '../../../shared/types'

function hexToRgb(hex: string): [number, number, number] | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim())
  if (!m) return null
  const n = parseInt(m[1], 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

/** black or white, whichever reads on this background */
function inkOn(hex: string): string {
  const rgb = hexToRgb(hex)
  if (!rgb) return '#fff'
  const [r, g, b] = rgb
  return r * 0.299 + g * 0.587 + b * 0.114 > 150 ? '#1a1a1a' : '#ffffff'
}

// ---------------------------------------------------------------------------
// Add/edit color dialog
// ---------------------------------------------------------------------------

function ColorEditDialog({
  color,
  palette,
  onSave,
  onRemove,
  onClose
}: {
  /** null = adding a new color */
  color: BrandColor | null
  palette: string
  onSave: (c: BrandColor) => void
  onRemove: (() => void) | null
  onClose: () => void
}): React.JSX.Element {
  const ref = useRef<HTMLDialogElement>(null)
  const [name, setName] = useState(color?.name ?? '')
  const [hex, setHex] = useState(color?.hex ?? '#')
  const [pantone, setPantone] = useState(color?.pantone ?? '')
  const [cmyk, setCmyk] = useState(color?.cmyk?.join('-') ?? '')
  const [confirmRemove, setConfirmRemove] = useState(false)

  useEffect(() => {
    ref.current?.showModal()
  }, [])

  const validHex = hexToRgb(hex) !== null

  function save(e: React.FormEvent): void {
    e.preventDefault()
    if (!name.trim() || !validHex) return
    const cmykParts = cmyk
      .split(/[-,\s]+/)
      .map((p) => parseInt(p, 10))
      .filter((n) => !isNaN(n))
    onSave({
      name: name.trim(),
      hex: hex.startsWith('#') ? hex.toUpperCase() : `#${hex.toUpperCase()}`,
      pantone: pantone.trim() || undefined,
      cmyk: cmykParts.length === 4 ? cmykParts : undefined
    })
  }

  return (
    <dialog
      ref={ref}
      className="confirm person-edit"
      onClose={onClose}
      onClick={(e) => {
        if (e.target === ref.current) onClose()
      }}
    >
      <form onSubmit={save}>
        <h3>{color ? `Edit ${color.name}` : `Add color to ${palette}`}</h3>
        <div className="pd-grid">
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
          <label className="pd-field">
            <span>Hex</span>
            <span className="hex-input">
              <span
                className="hex-preview"
                style={{ background: validHex ? hex : 'transparent' }}
                aria-hidden="true"
              />
              <input
                className="text-input"
                value={hex}
                onChange={(e) => setHex(e.target.value)}
                placeholder="#FFCC00"
                required
              />
            </span>
          </label>
          <label className="pd-field">
            <span>Pantone (optional)</span>
            <input
              className="text-input"
              value={pantone}
              onChange={(e) => setPantone(e.target.value)}
            />
          </label>
          <label className="pd-field">
            <span>CMYK (optional)</span>
            <input
              className="text-input"
              value={cmyk}
              onChange={(e) => setCmyk(e.target.value)}
              placeholder="0-20-100-2"
            />
          </label>
        </div>
        <div className="confirm-actions">
          {onRemove && (
            <button
              type="button"
              className="btn btn-danger pd-remove"
              onClick={() => {
                if (!confirmRemove) setConfirmRemove(true)
                else onRemove()
              }}
            >
              {confirmRemove ? 'Really remove?' : 'Remove'}
            </button>
          )}
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={!validHex}>
            Save
          </button>
        </div>
      </form>
    </dialog>
  )
}

// ---------------------------------------------------------------------------
// Brand page
// ---------------------------------------------------------------------------

export function BrandView(): React.JSX.Element {
  const [brand, setBrand] = useState<BrandData | null>(null)
  const [editing, setEditing] = useState<{ palette: string; color: BrandColor | null } | null>(null)
  const [copied, setCopied] = useState<string | null>(null)

  useEffect(() => {
    window.scribe.brand.get().then(setBrand)
  }, [])

  if (!brand) return <></>

  async function copy(key: string, text: string): Promise<void> {
    await navigator.clipboard.writeText(text)
    setCopied(key)
    setTimeout(() => setCopied((c) => (c === key ? null : c)), 1200)
  }

  async function update(next: BrandData): Promise<void> {
    setBrand(next)
    await window.scribe.brand.save(next)
  }

  function saveColor(paletteName: string, prev: BrandColor | null, color: BrandColor): void {
    const next: BrandData = {
      ...brand!,
      palettes: brand!.palettes.map((p) =>
        p.name !== paletteName
          ? p
          : {
              ...p,
              colors: prev
                ? p.colors.map((c) => (c.name === prev.name ? color : c))
                : [...p.colors, color]
            }
      )
    }
    update(next)
    setEditing(null)
  }

  function removeColor(paletteName: string, color: BrandColor): void {
    const next: BrandData = {
      ...brand!,
      palettes: brand!.palettes.map((p) =>
        p.name !== paletteName ? p : { ...p, colors: p.colors.filter((c) => c.name !== color.name) }
      )
    }
    update(next)
    setEditing(null)
  }

  const card = (paletteName: string, c: BrandColor): React.JSX.Element => {
    const rgb = c.hex ? hexToRgb(c.hex) : null
    const key = `${paletteName}/${c.name}`
    return (
      <div className="swatch-card" key={key}>
        {c.hex ? (
          <button
            className="swatch"
            style={{ background: c.hex, color: inkOn(c.hex) }}
            onClick={() => copy(`${key}/swatch`, c.hex!)}
            title="Copy hex"
          >
            {copied === `${key}/swatch` ? 'Copied' : ''}
          </button>
        ) : (
          <div className="swatch swatch-print-only">print only</div>
        )}
        <div className="swatch-info">
          <div className="swatch-name">{c.name}</div>
          {c.pantone && <div className="swatch-detail">Pantone {c.pantone}</div>}
          {c.cmyk && <div className="swatch-detail">CMYK {c.cmyk.join('-')}</div>}
          <div className="swatch-copies">
            {c.hex && (
              <button className="swatch-copy" onClick={() => copy(`${key}/hex`, c.hex!)}>
                {copied === `${key}/hex` ? 'Copied' : c.hex}
              </button>
            )}
            {rgb && (
              <button
                className="swatch-copy"
                onClick={() => copy(`${key}/rgb`, `rgb(${rgb.join(', ')})`)}
              >
                {copied === `${key}/rgb` ? 'Copied' : rgb.join(', ')}
              </button>
            )}
          </div>
        </div>
        <button
          className="btn btn-ghost swatch-edit"
          onClick={() => setEditing({ palette: paletteName, color: c })}
        >
          Edit
        </button>
      </div>
    )
  }

  return (
    <>
      {editing && (
        <ColorEditDialog
          color={editing.color}
          palette={editing.palette}
          onSave={(c) => saveColor(editing.palette, editing.color, c)}
          onRemove={editing.color ? () => removeColor(editing.palette, editing.color!) : null}
          onClose={() => setEditing(null)}
        />
      )}
      <div className="page-head">
        <h1>Brand</h1>
        <div className="page-head-tools">
          <span className="count-note">Rowan University brand standards</span>
        </div>
      </div>
      {brand.palettes.map((p) => (
        <section className="section" key={p.name}>
          <div className="person-section-head">
            <div className="card-subhead">{p.name}</div>
            <button
              className="btn btn-ghost"
              onClick={() => setEditing({ palette: p.name, color: null })}
            >
              Add color
            </button>
          </div>
          <div className="swatch-grid">{p.colors.map((c) => card(p.name, c))}</div>
        </section>
      ))}
      {brand.notes.length > 0 && (
        <section className="section">
          <div className="card-subhead">Using the colors</div>
          <ul className="brand-notes">
            {brand.notes.map((n) => (
              <li key={n}>{n}</li>
            ))}
          </ul>
        </section>
      )}
      {brand.typography && (
        <section className="section">
          <div className="card-subhead">Typography</div>
          <p className="brand-type">
            {brand.typography.primarySans}
            <br />
            Alternatives: {brand.typography.alternatives.join(', ')}
          </p>
        </section>
      )}
    </>
  )
}
