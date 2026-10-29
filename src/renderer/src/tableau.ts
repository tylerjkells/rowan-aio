/**
 * A Tableau view's address in embed mode: just the dashboard and its
 * toolbar, without Tableau Server's own header, menus and sidebar. Takes the
 * server's page links (…/#/views/Book/Sheet, …/#/site/Name/views/…) as well
 * as direct ones (…/views/Book/Sheet, …/t/Name/views/…), custom views
 * included, and keeps any filters set in the address. Null for anything
 * that isn't a single view on a Tableau host (a project, a workbook list,
 * the home page, another site): those only make sense as the full site.
 */
export function tableauEmbed(raw: string): string | null {
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
  const [, site, view] = m

  const given = new URLSearchParams(query)
  const params = new URLSearchParams()
  // filters and parameters ride along; Tableau's own : settings are ours to set
  for (const [k, v] of given) if (!k.startsWith(':')) params.append(k, v)
  params.set(':embed', 'y')
  params.set(':showVizHome', 'no')
  params.set(':showAppBanner', 'false')
  params.set(':display_count', 'no')
  // sheet tabs and the toolbar stay as the link asked, if it did
  params.set(':tabs', given.get(':tabs') ?? 'no')
  params.set(':toolbar', given.get(':toolbar') ?? 'yes')
  return `${u.origin}${site ? `/t/${site}` : ''}/${view.replace(/\/+$/, '')}?${params}`
}
