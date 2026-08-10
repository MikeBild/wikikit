import { Link, Outlet, useMatches } from '@tanstack/react-router'
import { useMutation } from '@tanstack/react-query'
import {
  Check,
  ChevronDown,
  ChevronsUpDown,
  Languages,
  LogOut,
  Monitor,
  Moon,
  Palette,
  Sun,
  UserRound,
} from 'lucide-react'
import { Fragment, useState, type ComponentType, type ReactNode } from 'react'
import { entryFor, GROUPS, NAV, type NavEntry, type NavGroup } from '@/app/nav'
import { endSession } from '@/api/client'
import { scopesLabel } from '@/lib/scopes'
import { useCan, useSession } from '@/lib/session'
import { useSpaceContext } from '@/lib/space'
import { toastFailure } from '@/lib/toast'
import { useTheme, type Theme } from '@/lib/theme'
import { useI18n, type LocalePreference } from '@/lib/i18n-context'
import type { TranslationKey } from '@/lib/i18n'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { Badge } from '@/components/ui/badge'
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '@/components/ui/breadcrumb'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Spinner } from '@/components/ui/spinner'
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarRail,
  SidebarTrigger,
} from '@/components/ui/sidebar'
import { TooltipProvider } from '@/components/ui/tooltip'
import { useSidebar } from '@/hooks/use-sidebar'

export function Shell() {
  const can = useCan()
  const { t } = useI18n()

  const signOut = useMutation({
    mutationFn: () => endSession(),
    // A reload, not a client-side redirect: the gate re-probes /v1/session and
    // shows the sign-in prompt. The theme key is deliberately untouched
    // (CUI-THEME-5) — an operator who chose dark signs back in to dark.
    onSuccess: () => window.location.reload(),
    // A session that will not end is a security-relevant fact, so it is said
    // out loud rather than left as a button that quietly does nothing.
    onError: (error) => toastFailure(t('account.signOutFailed'), error),
  })

  const visible = NAV.filter((entry) => entry.scope === null || can(entry.scope))
  const open = entryFor(useMatches().at(-1)?.pathname ?? '/')

  return (
    <TooltipProvider>
      {/*
        `min-h-0` is load-bearing and not cosmetic. A flex child defaults to
        `min-height: auto`, which refuses to shrink below its content — so an
        overflowing pane grows the shell instead of scrolling inside it, and the
        document gets a scrollbar `body { overflow: hidden }` has already
        suppressed. The result is a page whose bottom is simply unreachable,
        with nothing on screen to say so (CUI-LAYOUT-1).
      */}
      <SidebarProvider data-cockpit-ui="cockpit-ui" className="h-full min-h-0">
        <Sidebar collapsible="icon" data-testid="sidebar">
          <SidebarHeader>
            <div className="flex h-8 items-center px-2 text-sm font-semibold tracking-[0.16em] group-data-[collapsible=icon]:hidden">
              WIKIKIT
            </div>
            <SpaceSwitcher />
          </SidebarHeader>

          <SidebarContent>
            <nav aria-label={t('nav.label')}>
              {GROUPS.map((group) => {
                const items = visible.filter((entry) => entry.group === group.id)
                if (items.length === 0) return null
                return <NavBlock key={group.id} group={group} items={items} open={open} />
              })}
            </nav>
          </SidebarContent>

          <SidebarFooter>
            <SidebarMenu>
              <SidebarMenuItem>
                <AccountMenu signingOut={signOut.isPending} onSignOut={() => signOut.mutate()} />
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarFooter>
          <SidebarRail />
        </Sidebar>

        {/*
          `min-w-0` for the same reason as `min-h-0` above, in the other axis: a
          table wider than the pane would otherwise push the whole shell
          sideways rather than scrolling inside its own container.
        */}
        <SidebarInset className="min-h-0 min-w-0">
          {/*
            A 48px strip carrying the sidebar trigger and nothing else — the
            pages own their content, and a header that collects page-specific
            controls turns into a second toolbar nobody decided to have.
          */}
          <header className="border-border flex h-12 shrink-0 items-center gap-3 border-b px-4">
            <SidebarTrigger data-testid="sidebar-trigger" />
          </header>
          <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto">
            <Outlet />
          </div>
        </SidebarInset>
      </SidebarProvider>
    </TooltipProvider>
  )
}

/**
 * Which wiki you are reading, at the top of the sidebar.
 *
 * A dropdown rather than a `<select>`: it has to survive the sidebar
 * collapsing to a 3rem rail, where a native select has no room for its label
 * and no tooltip to explain itself.
 *
 * Hidden entirely when the session is bound to one wiki. A switcher with one
 * option that cannot change is a control that teaches the reader nothing and
 * costs them a click to discover that.
 */
function SpaceSwitcher() {
  const { space, available, setSpace, locked } = useSpaceContext()
  const { t } = useI18n()
  if (locked || available.length < 2) {
    return space ? (
      <div
        data-testid="space-current"
        className="text-muted-foreground truncate px-2 pb-1 text-xs group-data-[collapsible=icon]:hidden"
      >
        {space}
      </div>
    ) : null
  }
  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <SidebarMenuButton data-testid="space-switcher" tooltip={space ?? t('space.fallback')}>
              <span className="truncate">{space ?? t('space.choose')}</span>
              <ChevronsUpDown data-icon="inline-end" className="ml-auto" />
            </SidebarMenuButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent side="right" align="start" className="min-w-48">
            <DropdownMenuGroup>
              {available.map((slug) => (
                <DropdownMenuItem key={slug} data-testid={`space-${slug}`} onSelect={() => setSpace(slug)}>
                  {slug === space ? <Check data-icon="inline-start" /> : <span className="w-4" />}
                  <span className="truncate">{slug}</span>
                </DropdownMenuItem>
              ))}
            </DropdownMenuGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  )
}

function NavBlock({ group, items, open }: { group: NavGroup; items: readonly NavEntry[]; open: NavEntry | undefined }) {
  const { state } = useSidebar()
  const { t } = useI18n()
  const [expanded, setExpanded] = useState(group.startsOpen)
  const holdsOpenPage = items.some((item) => item.to === open?.to)

  // A block holding the page the operator is looking at is open, and that is
  // DERIVED rather than synchronised: an effect that calls setState in its body
  // renders twice on every route change, and there is nothing external to sync
  // with here — the answer is a function of props the component already has.
  // The collapsed rail has no labels to collapse under, so it forces open too.
  const isOpen = state === 'collapsed' || expanded || holdsOpenPage

  const menu = (
    <SidebarGroupContent>
      <SidebarMenu>
        {items.map((entry) => {
          const { to, icon: Icon } = entry
          const label = t(navKey(entry))
          return (
            <SidebarMenuItem key={to}>
              <SidebarMenuButton asChild isActive={open?.to === to} tooltip={label}>
                <Link to={to} data-testid={`nav-${to === '/' ? 'home' : to.slice(1)}`}>
                  <Icon data-icon="inline-start" />
                  <span>{label}</span>
                </Link>
              </SidebarMenuButton>
            </SidebarMenuItem>
          )
        })}
      </SidebarMenu>
    </SidebarGroupContent>
  )

  if (!group.collapsible)
    return (
      <SidebarGroup data-testid={`nav-group-${group.id}`} className={group.separated ? 'border-border border-t' : ''}>
        {menu}
      </SidebarGroup>
    )

  return (
    <Collapsible open={isOpen} onOpenChange={setExpanded} className="group/collapsible">
      <SidebarGroup
        data-testid={`nav-group-${group.id}`}
        className={group.separated ? 'border-border mt-2 border-t' : ''}
      >
        <SidebarGroupLabel asChild>
          <CollapsibleTrigger data-testid={`nav-group-${group.id}-toggle`}>
            {t(groupKey(group.id))}
            <ChevronDown
              data-icon="inline-end"
              className="ml-auto transition-transform group-data-[state=closed]/collapsible:-rotate-90"
            />
          </CollapsibleTrigger>
        </SidebarGroupLabel>
        <CollapsibleContent>{menu}</CollapsibleContent>
      </SidebarGroup>
    </Collapsible>
  )
}

const THEMES: { value: Theme; label: TranslationKey; icon: ComponentType<{ className?: string }> }[] = [
  { value: 'system', label: 'account.theme.system', icon: Monitor },
  { value: 'light', label: 'account.theme.light', icon: Sun },
  { value: 'dark', label: 'account.theme.dark', icon: Moon },
]

const LANGUAGES: { value: LocalePreference; label: TranslationKey }[] = [
  { value: 'auto', label: 'account.language.auto' },
  { value: 'en', label: 'account.language.en' },
  { value: 'de', label: 'account.language.de' },
]

function initials(value: string): string {
  return (
    value
      .split(/[@\s._-]+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0]?.toUpperCase())
      .join('') || 'WK'
  )
}

function AccountMenu({ signingOut, onSignOut }: { signingOut: boolean; onSignOut: () => void }) {
  const session = useSession()
  const { t, preference, setPreference } = useI18n()
  const { theme, setTheme } = useTheme()
  const signInType = session.kind === 'api_key' ? t('account.apiKey') : t('account.identity')
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <SidebarMenuButton size="lg" data-testid="account-menu-trigger" tooltip={t('account.menu')}>
          <Avatar>
            <AvatarFallback>{initials(session.name)}</AvatarFallback>
          </Avatar>
          <span className="grid min-w-0 flex-1 text-left text-sm leading-tight">
            <span className="truncate font-medium" data-testid="operator-name">
              {session.name}
            </span>
            <span className="truncate text-xs text-muted-foreground" data-testid="operator-scopes">
              {scopesLabel(session.scopes)}
            </span>
          </span>
          <ChevronsUpDown className="ml-auto" />
        </SidebarMenuButton>
      </DropdownMenuTrigger>
      <DropdownMenuContent side="right" align="end" className="w-64" data-testid="account-menu">
        <DropdownMenuLabel data-testid="account-profile-summary">
          <span className="block truncate text-sm font-medium text-foreground">{session.name}</span>
          <span className="block truncate font-normal">{signInType}</span>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuGroup>
          <DropdownMenuSub>
            <DropdownMenuSubTrigger data-testid="account-profile-menu">
              <UserRound />
              {t('account.profile')}
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="w-72" data-testid="account-profile-content">
              <DropdownMenuLabel className="flex flex-col gap-2">
                <span className="truncate text-sm font-medium text-foreground">{session.name}</span>
                <span className="font-normal">
                  {t('account.signInType')}: {signInType}
                </span>
                <span className="font-normal">{t('account.permissions')}</span>
                <ScopeBadges scopes={session.scopes} />
              </DropdownMenuLabel>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
          <DropdownMenuSub>
            <DropdownMenuSubTrigger data-testid="account-language-menu">
              <Languages />
              {t('account.language')}
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent data-testid="account-language-content">
              <DropdownMenuRadioGroup
                value={preference}
                onValueChange={(value) => setPreference(value as LocalePreference)}
              >
                {LANGUAGES.map(({ value, label }) => (
                  <DropdownMenuRadioItem key={value} value={value} data-testid={`account-language-${value}`}>
                    {t(label)}
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
          <DropdownMenuSub>
            <DropdownMenuSubTrigger data-testid="account-theme-menu">
              <Palette />
              {t('account.theme')}
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent data-testid="account-theme-content">
              <DropdownMenuRadioGroup value={theme} onValueChange={(value) => setTheme(value as Theme)}>
                {THEMES.map(({ value, label, icon: ItemIcon }) => (
                  <DropdownMenuRadioItem key={value} value={value} data-testid={`account-theme-${value}`}>
                    <ItemIcon />
                    {t(label)}
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuGroup>
          <DropdownMenuItem
            variant="destructive"
            disabled={signingOut}
            data-testid="account-sign-out"
            onSelect={onSignOut}
          >
            {signingOut ? <Spinner data-icon="inline-start" /> : <LogOut data-icon="inline-start" />}
            {t(signingOut ? 'account.signingOut' : 'account.signOut')}
          </DropdownMenuItem>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

const NAV_KEYS: Record<string, TranslationKey> = {
  '/': 'nav.home',
  '/pages': 'nav.pages',
  '/changes': 'nav.changes',
  '/sources': 'nav.sources',
  '/decisions': 'nav.decisions',
  '/search': 'nav.search',
  '/charter': 'nav.charter',
  '/spaces': 'nav.spaces',
  '/api-keys': 'nav.apiKeys',
  '/identities': 'nav.identities',
  '/webhooks': 'nav.webhooks',
  '/system': 'nav.system',
}

function navKey(entry: NavEntry): TranslationKey {
  return NAV_KEYS[entry.to] ?? 'nav.home'
}

function groupKey(id: string): TranslationKey {
  return `nav.group.${id}` as TranslationKey
}

const PAGE_KEYS: Record<string, { title: TranslationKey; description: TranslationKey }> = {
  Home: { title: 'nav.home', description: 'page.home.description' },
  Pages: { title: 'nav.pages', description: 'page.pages.description' },
  Changes: { title: 'nav.changes', description: 'page.changes.description' },
  Sources: { title: 'nav.sources', description: 'page.sources.description' },
  Decisions: { title: 'nav.decisions', description: 'page.decisions.description' },
  Search: { title: 'nav.search', description: 'page.search.description' },
  Charter: { title: 'nav.charter', description: 'page.charter.description' },
  Wikis: { title: 'nav.spaces', description: 'page.spaces.description' },
  'API keys': { title: 'nav.apiKeys', description: 'page.apiKeys.description' },
  People: { title: 'nav.identities', description: 'page.identities.description' },
  Webhooks: { title: 'nav.webhooks', description: 'page.webhooks.description' },
  System: { title: 'nav.system', description: 'page.system.description' },
}

/**
 * The page frame: one heading, one description, and the actions that belong to
 * this page.
 *
 * Every route renders exactly one of these, so the container width, the
 * breadcrumb and the responsive behaviour of the header are decided once.
 */
export function Page({
  title,
  description,
  actions,
  children,
}: {
  title: string
  description?: string
  actions?: ReactNode
  children: ReactNode
}) {
  const { t } = useI18n()
  const page = PAGE_KEYS[title]
  const localizedTitle = page ? t(page.title) : title
  const localizedDescription = page ? t(page.description) : description
  const crumbs = useCrumbs(localizedTitle)
  return (
    <div data-testid="page" data-page={title} className="mx-auto max-w-7xl p-4 sm:p-6">
      {/*
        The actions drop below the title on a phone. Beside it they are
        `shrink-0`, which is right at 1280 and wrong at 390, where a 100px
        button and its gap take a third of the row and leave the description
        wrapping in what is left.
      */}
      <header className="mb-5 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
        <div className="flex min-w-0 flex-col gap-1">
          {/*
            A crumb is a link exactly when it names a route. The group does not
            — there is no page for "Wiki" — so it renders as text; the section a
            detail page sits under does, and on a detail page that link is the
            way back. Exactly one crumb is the BreadcrumbPage, because that is
            what carries aria-current="page", and two of them announce two
            current pages. A single crumb is the page's own title, one line
            above the <h1> that already says it, so a page directly under the
            root shows none.
          */}
          {crumbs.length < 2 ? null : (
            <Breadcrumb
              data-testid="breadcrumb"
              data-trail={crumbs.map((crumb) => crumb.label).join(' · ')}
              className="text-xs"
            >
              <BreadcrumbList className="text-xs">
                {crumbs.map((crumb, index) => (
                  <Fragment key={`${index}-${crumb.label}`}>
                    {index > 0 ? <BreadcrumbSeparator /> : null}
                    <BreadcrumbItem data-testid={`breadcrumb-item-${index}`}>
                      {index === crumbs.length - 1 ? (
                        <BreadcrumbPage>{crumb.label}</BreadcrumbPage>
                      ) : crumb.to ? (
                        <BreadcrumbLink asChild>
                          <Link to={crumb.to} data-testid={`breadcrumb-link-${index}`}>
                            {crumb.label}
                          </Link>
                        </BreadcrumbLink>
                      ) : (
                        <span>{crumb.label}</span>
                      )}
                    </BreadcrumbItem>
                  </Fragment>
                ))}
              </BreadcrumbList>
            </Breadcrumb>
          )}
          <h1 data-testid="page-title" className="text-lg font-semibold tracking-tight">
            {localizedTitle}
          </h1>
          {localizedDescription ? <p className="text-muted-foreground text-sm">{localizedDescription}</p> : null}
        </div>
        {actions ? <div className="flex shrink-0 gap-2">{actions}</div> : null}
      </header>
      {children}
    </div>
  )
}

/** `Wiki · Changes · <title>`, with the section linked where it is not the page itself. */
function useCrumbs(title: string): { label: string; to?: string }[] {
  const { t } = useI18n()
  const entry = entryFor(useMatches().at(-1)?.pathname ?? '/')
  const group = GROUPS.find((candidate) => candidate.id === entry?.group)
  const trail: { label: string; to?: string }[] = []
  if (group?.label) trail.push({ label: t(groupKey(group.id)) })
  // A detail route sits under its section: "Wiki · Changes · <title>".
  if (entry && entry.label !== title) trail.push({ label: t(navKey(entry)), to: entry.to })
  trail.push({ label: title })
  return trail
}

/** The scopes an operator holds, printed where there is room to explain them. */
export function ScopeBadges({ scopes }: { scopes: readonly string[] }) {
  return (
    <div className="flex flex-wrap gap-1">
      {scopes.map((scope) => (
        <Badge key={scope} tone="unknown" className="font-mono text-[10px]">
          {scope}
        </Badge>
      ))}
    </div>
  )
}
