import { createContext, useContext } from 'react'

/**
 * The sidebar's shared state, lifted out of `components/ui/sidebar.tsx`.
 *
 * The registry keeps the context and the hook in the same module as the
 * components, which `eslint-plugin-react-refresh` refuses: a module that exports
 * both a component and something else loses fast refresh, so every sidebar edit
 * would remount the whole console instead of hot-swapping. `components/ui/button.tsx`
 * carries the same rule for its variant table, and the answer there was the same
 * — move the non-component out rather than add an exception.
 */
export interface SidebarState {
  state: 'expanded' | 'collapsed'
  open: boolean
  setOpen: (open: boolean) => void
  openMobile: boolean
  setOpenMobile: (open: boolean) => void
  isMobile: boolean
  toggleSidebar: () => void
}

export const SidebarContext = createContext<SidebarState | null>(null)

export function useSidebar(): SidebarState {
  const context = useContext(SidebarContext)
  if (!context) throw new Error('useSidebar must be used within a SidebarProvider.')
  return context
}
