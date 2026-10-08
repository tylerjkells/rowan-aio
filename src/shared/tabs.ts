import type { NavTab } from './types'

/**
 * The sidebar tabs a user can switch off in Settings, in sidebar order.
 * Today and Settings are not listed: they always show.
 */
export const NAV_TABS: { id: NavTab; label: string; group: 'Meetings' | 'Workspace'; desc: string }[] = [
  { id: 'library', label: 'Library', group: 'Meetings', desc: 'Recorded and imported meetings.' },
  { id: 'actions', label: 'Action items', group: 'Meetings', desc: 'Everything meetings asked of anyone.' },
  { id: 'people', label: 'People', group: 'Workspace', desc: 'The team directory and person pages.' },
  { id: 'projects', label: 'ClickUp', group: 'Workspace', desc: 'Your ClickUp tasks. Needs a ClickUp token.' },
  { id: 'mail', label: 'Mail', group: 'Workspace', desc: 'Outlook through the mail bridge. Needs the bridge set up.' },
  { id: 'tickets', label: 'Tickets', group: 'Workspace', desc: 'ServiceNow incidents assigned to you.' },
  { id: 'dashboards', label: 'Dashboards', group: 'Workspace', desc: 'Dashboards embedded in the app, signed in once.' },
  { id: 'links', label: 'Links', group: 'Workspace', desc: 'Dashboards and org links.' },
  { id: 'brand', label: 'Brand', group: 'Workspace', desc: 'Colors, type, and logos.' },
  { id: 'toolbox', label: 'Toolbox', group: 'Workspace', desc: 'Guides, images, saved queries, and files.' }
]

export function isNavTab(value: unknown): value is NavTab {
  return NAV_TABS.some((t) => t.id === value)
}
