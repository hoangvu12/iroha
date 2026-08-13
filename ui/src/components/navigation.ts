import {
  Activity,
  KeyRound,
  ScrollText,
  Server,
  Settings,
  SquareChartGantt,
  type LucideIcon,
} from 'lucide-react'

export interface NavigationItem {
  readonly id: string
  readonly label: string
  readonly icon: LucideIcon
  /** Single-letter keyboard shortcut hint, surfaced as a chip in the sidebar. */
  readonly hint: string
}

export const PRIMARY_NAVIGATION: readonly NavigationItem[] = [
  { id: 'overview', label: 'Overview', icon: Activity, hint: 'O' },
  { id: 'providers', label: 'Providers', icon: Server, hint: 'P' },
  { id: 'gateway-keys', label: 'Gateway Keys', icon: KeyRound, hint: 'G' },
  { id: 'requests', label: 'Requests', icon: SquareChartGantt, hint: 'R' },
  { id: 'audit', label: 'Audit', icon: ScrollText, hint: 'A' },
  { id: 'settings', label: 'Settings', icon: Settings, hint: 'S' },
]

/** A connection-detail sub-area. The shell renders its own segmented control. */
export type ConnectionSection =
  | 'overview'
  | 'upstream-keys'
  | 'models'
  | 'usage'
  | 'logs'
  | 'settings'

export interface ConnectionSectionItem {
  readonly id: ConnectionSection
  readonly label: string
}

export const CONNECTION_SECTIONS: readonly ConnectionSectionItem[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'upstream-keys', label: 'Upstream Keys' },
  { id: 'models', label: 'Models' },
  { id: 'usage', label: 'Usage' },
  { id: 'logs', label: 'Logs' },
  { id: 'settings', label: 'Settings' },
]