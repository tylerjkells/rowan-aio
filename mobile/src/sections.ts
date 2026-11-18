import type React from 'react'
import {
  ActionsIcon,
  GaugeIcon,
  LinkIcon,
  MeetingsIcon,
  PaletteIcon,
  PeopleIcon,
  PlannerIcon,
  TicketIcon,
  TodayIcon,
  ToolboxIcon
} from './ui'

/**
 * Every section of the phone app, in the desktop sidebar's order. `hideKey`
 * is the desktop's own name for the tab (Settings → Tabs), so a section
 * switched off there is left out here too. Mail and ClickUp have no phone
 * section: mail isn't synced (each PC reads its own OneDrive copy) and
 * ClickUp needs the token that stays on the PC; both have iPhone apps.
 */
export interface Section {
  name: string
  label: string
  Icon: (p: { size?: number }) => React.JSX.Element
  hideKey?: string
}

export const SECTIONS: Section[] = [
  { name: 'today', label: 'Today', Icon: TodayIcon },
  { name: 'meetings', label: 'Meetings', Icon: MeetingsIcon, hideKey: 'library' },
  { name: 'actions', label: 'Action items', Icon: ActionsIcon, hideKey: 'actions' },
  { name: 'people', label: 'People', Icon: PeopleIcon, hideKey: 'people' },
  { name: 'planner', label: 'Planner', Icon: PlannerIcon, hideKey: 'planner' },
  { name: 'tickets', label: 'Tickets', Icon: TicketIcon, hideKey: 'tickets' },
  { name: 'dashboards', label: 'Dashboards', Icon: GaugeIcon, hideKey: 'dashboards' },
  { name: 'links', label: 'Links', Icon: LinkIcon, hideKey: 'links' },
  { name: 'brand', label: 'Brand', Icon: PaletteIcon, hideKey: 'brand' },
  { name: 'toolbox', label: 'Toolbox', Icon: ToolboxIcon, hideKey: 'toolbox' }
]

/** the sections in the phone's bottom tab bar; everything else is under More */
export const TAB_SECTIONS = ['today', 'meetings', 'actions']

export function visibleSections(hidden: string[] | undefined): Section[] {
  const off = new Set(hidden ?? [])
  return SECTIONS.filter((s) => !s.hideKey || !off.has(s.hideKey))
}
