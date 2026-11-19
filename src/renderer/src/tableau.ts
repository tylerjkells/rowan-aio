interface TableauView {
  origin: string
  /** the site's content name, for views outside the default site */
  site?: string
  /** views/Workbook/Sheet, plus a custom view if there is one */
  view: string
  /** the address's own query: filters, parameters, Tableau's : settings */
  query: URLSearchParams
}

/**
 * The single view a Tableau address points at. Takes the server's page links
 * (…/#/views/Book/Sheet, …/#/site/Name/views/…) as well as direct ones
 * (…/views/Book/Sheet, …/t/Name/views/…), custom views included. Null for
 * anything that isn't a single view on a Tableau host (a project, a workbook
 * list, the home page, another site).
 */
function tableauView(raw: string): TableauView | null {
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    return null
  }
  if (!/tableau/i.test(u.hostname)) return null
  // the server's own pages route after the #
  let path = u.pathname
  let query = u.search
  const hash = u.hash.replace(/^#/, '')
  if (hash.startsWith('/')) {
    const q = hash.indexOf('?')
    path = q < 0 ? hash : hash.slice(0, q)
    query = q < 0 ? '' : hash.slice(q)
  }
  const m = path.match(/^\/(?:(?:t|site)\/([^/]+)\/)?(views\/[^/]+\/[^/]+(?:\/.*)?)$/)
  if (!m) return null
  return { origin: u.origin, site: m[1], view: m[2].replace(/\/+$/, ''), query: new URLSearchParams(query) }
}

/**
 * A Tableau view's address in embed mode: just the dashboard and its
 * toolbar, without Tableau Server's own header, menus and sidebar. Keeps any
 * filters set in the address. Null for anything that isn't a single view:
 * those only make sense as the full site.
 */
export function tableauEmbed(raw: string): string | null {
  const v = tableauView(raw)
  if (!v) return null
  const params = new URLSearchParams()
  // filters and parameters ride along; Tableau's own : settings are ours to set
  for (const [k, val] of v.query) if (!k.startsWith(':')) params.append(k, val)
  params.set(':embed', 'y')
  params.set(':showVizHome', 'no')
  params.set(':showAppBanner', 'false')
  params.set(':display_count', 'no')
  // sheet tabs and the toolbar stay as the link asked, if it did
  params.set(':tabs', v.query.get(':tabs') ?? 'no')
  params.set(':toolbar', v.query.get(':toolbar') ?? 'yes')
  return `${v.origin}${v.site ? `/t/${v.site}` : ''}/${v.view}?${params}`
}

/** InstructorEngagementDashboard → Instructor Engagement Dashboard; ROOpsStatus → RO Ops Status */
function spaced(part: string): string {
  let s = part
  try {
    s = decodeURIComponent(part)
  } catch {
    // keep it as written
  }
  return s
    .replace(/[_+]+/g, ' ')
    .replace(/([a-z\d])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/\s+/g, ' ')
    .trim()
}

/** A sidebar name for a Tableau view: its workbook, and its sheet unless that's a stock name like Dashboard 1 */
export function tableauName(raw: string): string | null {
  const v = tableauView(raw)
  if (!v) return null
  const [, book, sheet] = v.view.split('/')
  const b = spaced(book)
  const s = spaced(sheet)
  if (!s || /^(sheet|dashboard|story)\s*\d*$/i.test(s) || s.toLowerCase() === b.toLowerCase()) return b
  return `${b} · ${s}`
}

/**
 * The address inside pasted embed code: Tableau's <tableau-viz src=…> (Share
 * → Embed Code), the older <object class="tableauViz"> with host_url,
 * site_root and name params, or any <iframe src=…>. Where the code puts the
 * toolbar rides along in the address; its size doesn't, since the pane sets
 * that. Null when the text isn't markup or names no address.
 */
export function addressFromEmbedCode(raw: string): string | null {
  if (!/<[a-z]/i.test(raw)) return null
  // an inert document: nothing in it runs or loads
  const doc = new DOMParser().parseFromString(raw, 'text/html')

  const viz = doc.querySelector('tableau-viz[src], tableau-authoring-viz[src]')
  if (viz) {
    let u: URL
    try {
      u = new URL(viz.getAttribute('src')!.trim())
    } catch {
      return null
    }
    const toolbar = viz.getAttribute('toolbar')?.toLowerCase()
    if (toolbar === 'hidden') u.searchParams.set(':toolbar', 'no')
    else if (toolbar === 'top') u.searchParams.set(':toolbar', 'top')
    // :toolbar reads better than %3Atoolbar in the address field; Tableau takes either
    return `${u.origin}${u.pathname}${u.search.replace(/%3A/gi, ':')}${u.hash}`
  }

  const obj = doc.querySelector('object.tableauViz')
  if (obj) {
    const param = (name: string): string =>
      obj.querySelector(`param[name="${name}"]`)?.getAttribute('value')?.trim() ?? ''
    let host = param('host_url')
    try {
      host = decodeURIComponent(host)
    } catch {
      // already plain
    }
    const name = param('name')
    if (!/^https?:\/\//i.test(host) || !name) return null
    const site = param('site_root').replace(/\/+$/, '')
    return `${host.replace(/\/+$/, '')}${site}/views/${name.replace(/^\/+/, '')}`
  }

  const src = doc.querySelector('iframe[src]')?.getAttribute('src')?.trim()
  return src && /^https?:\/\//i.test(src) ? src : null
}
