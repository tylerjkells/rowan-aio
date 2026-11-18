import { useEffect, useState } from 'react'
import type { BrandData } from '../../../src/shared/types'
import { useApp } from '../App'
import { loadBrand, peek } from '../data'
import { Problem, Stale } from '../ui'

/** black or white, whichever reads on this swatch */
function inkOn(hex: string): string {
  const n = parseInt(hex.replace('#', ''), 16)
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255]
  return 0.299 * r + 0.587 * g + 0.114 * b > 150 ? '#1c1c1e' : '#ffffff'
}

export function BrandView(): React.JSX.Element {
  const { hub, fail, tick } = useApp()
  const [brand, setBrand] = useState<BrandData | null>(() => peek('brand'))
  const [stale, setStale] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState<string | null>(null)

  useEffect(() => {
    let live = true
    loadBrand(hub)
      .then((r) => {
        if (!live) return
        setBrand(r.value)
        setStale(r.stale)
        setError(null)
      })
      .catch((err) => live && setError(fail(err)))
    return () => {
      live = false
    }
  }, [hub, tick, fail])

  function copy(text: string): void {
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(text)
      setTimeout(() => setCopied(null), 1400)
    })
  }

  return (
    <>
      <header className="page-head">
        <h1 className="large-title">Brand</h1>
        <p className="lead">Tap a color to copy its hex code.</p>
      </header>
      <Stale show={stale} />
      <Problem error={error} />
      {!brand ? (
        <p className="empty">The brand guide hasn’t synced yet. Open Brand in Rowan on your PC once.</p>
      ) : (
        <>
          {brand.palettes.map((p) => (
            <section key={p.name}>
              <h2 className="section-title">{p.name}</h2>
              <div className="swatches">
                {p.colors.map((c) => (
                  <button
                    key={c.name}
                    className="swatch"
                    disabled={!c.hex}
                    onClick={() => c.hex && copy(c.hex)}
                    aria-label={c.hex ? `${c.name}, ${c.hex}, copy` : `${c.name}, print only`}
                  >
                    <span className="swatch-chip" style={c.hex ? { background: c.hex, color: inkOn(c.hex) } : undefined}>
                      {c.hex && copied === c.hex ? 'Copied' : ''}
                    </span>
                    <span className="swatch-name">{c.name}</span>
                    <span className="swatch-code">{c.hex ?? 'Print only'}</span>
                    {c.pantone && <span className="swatch-code">{c.pantone}</span>}
                  </button>
                ))}
              </div>
            </section>
          ))}
          {brand.typography && (
            <section>
              <h2 className="section-title">Type</h2>
              <p className="plain">
                {brand.typography.primarySans}
                {brand.typography.alternatives.length ? ` (alternatives: ${brand.typography.alternatives.join(', ')})` : ''}
              </p>
            </section>
          )}
          {brand.notes.length > 0 && (
            <section>
              <h2 className="section-title">Usage</h2>
              <ul className="bullets">
                {brand.notes.map((n, i) => (
                  <li key={i}>{n}</li>
                ))}
              </ul>
            </section>
          )}
        </>
      )}
    </>
  )
}
