import { useApp } from '../App'
import { TAB_SECTIONS, visibleSections } from '../sections'
import { ChevronIcon } from '../ui'

export function MoreView(): React.JSX.Element {
  const { hub, settings, signOut } = useApp()
  const items = visibleSections(settings?.hiddenTabs).filter((s) => !TAB_SECTIONS.includes(s.name))

  return (
    <>
      <header className="page-head">
        <h1 className="large-title">More</h1>
      </header>
      <div className="group">
        {items.map(({ name, label, Icon }) => (
          <a key={name} className="row" href={`#/${name}`}>
            <span className="row-icon">
              <Icon size={20} />
            </span>
            <span className="row-main">
              <span className="row-title">{label}</span>
            </span>
            <ChevronIcon size={18} />
          </a>
        ))}
      </div>

      <section>
        <h2 className="section-title">Account</h2>
        <div className="group">
          <div className="row">
            <span className="row-main">
              <span className="row-title">{hub.email}</span>
              <span className="row-sub">Your theme and hidden sections follow Rowan on your PC.</span>
            </span>
          </div>
          <button className="row danger-row" onClick={signOut}>
            Sign out
          </button>
        </div>
      </section>
      <p className="fine">Mail and ClickUp stay on your PC: mail isn’t synced, and ClickUp has its own iPhone app.</p>
    </>
  )
}
