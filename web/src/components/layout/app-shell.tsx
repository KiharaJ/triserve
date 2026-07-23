import {
  Activity,
  ArrowLeftRight,
  BadgeCheck,
  BarChart3,
  Boxes,
  Building2,
  ChevronDown,
  ClipboardCheck,
  Factory,
  KeyRound,
  BookOpen,
  Gauge,
  LayoutDashboard,
  LayoutGrid,
  PlusCircle,
  LogOut,
  MapPin,
  Package,
  Receipt,
  RefreshCw,
  ScanBarcode,
  ScrollText,
  ShieldCheck,
  ShoppingBag,
  Smartphone,
  ShoppingCart,
  SlidersHorizontal,
  Truck,
  Users,
  Wrench,
} from 'lucide-react'
import { NavLink, Outlet, useLocation } from 'react-router-dom'
import { useEffect, useState } from 'react'
import type { Permission } from '@triserve/shared'
import { Menu, Moon, Sun, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useAuth } from '@/lib/auth'
import { useTheme } from '@/lib/theme'
import { cn } from '@/lib/utils'

const navItemClass = (active: boolean): string =>
  cn(
    'group relative flex items-center gap-3 rounded-lg px-2.5 py-1.5 text-sm font-medium transition-all',
    active
      ? 'bg-accent text-foreground'
      : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground',
  )

/**
 * Whether a sidebar entry is the one you are on.
 *
 * NavLink matches on PATHNAME alone, so `/jobs` and `/jobs?view=board` would
 * both light up on the jobs page — exactly the two-entries-highlighted
 * confusion the role grouping exists to remove. An entry carrying a query must
 * match that query too; an entry without one must NOT match when a
 * query-bearing sibling does.
 */
function isEntryActive(
  pathMatches: boolean,
  to: string,
  search: string,
): boolean {
  if (!pathMatches) return false
  const [, query] = to.split('?')
  const current = new URLSearchParams(search)
  if (query) {
    const wanted = new URLSearchParams(query)
    for (const [k, v] of wanted) if (current.get(k) !== v) return false
    return true
  }
  // A plain entry yields to a sibling that pins the same key.
  return !current.get('view')
}

/** localStorage key for the user's collapsed sidebar sections. */
const NAV_COLLAPSED_KEY = 'triserve.nav.collapsed'

/**
 * Does a section hold the page you're on? Used to tint a COLLAPSED section's
 * heading, so folding a section away never hides where you are.
 */
function sectionHasActive(
  items: { to: string; end?: boolean }[],
  pathname: string,
): boolean {
  return items.some(({ to, end }) => {
    const path = to.split('?')[0]
    return end ? pathname === path : pathname === path || pathname.startsWith(`${path}/`)
  })
}

/** Light/dark toggle for the topbar. */
function ThemeToggle() {
  const { resolved, toggle } = useTheme()
  return (
    <Button
      variant="outline"
      size="icon"
      className="size-9"
      onClick={toggle}
      aria-label={resolved === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
      title={resolved === 'dark' ? 'Light mode' : 'Dark mode'}
    >
      {resolved === 'dark' ? (
        <Sun className="size-4" />
      ) : (
        <Moon className="size-4" />
      )}
    </Button>
  )
}

interface NavItem {
  to: string
  label: string
  icon: typeof LayoutDashboard
  end: boolean
  /** Icon-chip color: full static Tailwind classes (bg tint + icon color). */
  color: string
  /** Hidden without this permission (UX only — the API re-checks). */
  permission?: Permission
}

interface NavSection {
  heading?: string
  items: NavItem[]
}

/**
 * Grouped by WHAT PEOPLE DO, not by what the data is.
 *
 * The previous grouping (CRM / Sales / Inventory) named tables. A front-desk
 * clerk does not think "I need the CRM module" — they think "someone is at the
 * counter with a broken phone". Sections now follow the path a repair takes:
 * front desk → workshop → aftersales, with the supporting functions after.
 *
 * NO destination appears twice. A duplicated entry lights up in two places at
 * once and stops the sidebar answering "where am I". Where a screen serves two
 * roles it is filed under the one that opens it most, and the other role
 * reaches it from the guide or from within the job.
 */
const NAV_SECTIONS: NavSection[] = [
  {
    items: [
      { to: '/', label: 'Dashboard', icon: LayoutDashboard, end: true, color: 'bg-indigo-500/15 text-indigo-600 dark:text-indigo-400' },
      // No permission: everyone needs to be able to look up how their job works.
      { to: '/guide', label: 'How this works', icon: BookOpen, end: false, color: 'bg-violet-500/15 text-violet-600 dark:text-violet-400' },
    ],
  },
  {
    heading: 'Front desk',
    items: [
      { to: '/jobs/new', label: 'Book a job', icon: PlusCircle, end: false, permission: 'job.create', color: 'bg-blue-500/15 text-blue-600 dark:text-blue-400' },
      { to: '/jobs', label: 'Jobs', icon: Wrench, end: true, permission: 'job.read', color: 'bg-blue-500/15 text-blue-600 dark:text-blue-400' },
      { to: '/customers', label: 'Customers', icon: Users, end: true, permission: 'customer.read', color: 'bg-sky-500/15 text-sky-600 dark:text-sky-400' },
      { to: '/devices', label: 'Devices', icon: Smartphone, end: false, permission: 'device.read', color: 'bg-teal-500/15 text-teal-600 dark:text-teal-400' },
    ],
  },
  {
    heading: 'Workshop',
    items: [
      // Straight to the board — the bench works the columns, not the list.
      { to: '/jobs?view=board', label: 'Job board', icon: LayoutGrid, end: false, permission: 'job.read', color: 'bg-amber-500/15 text-amber-600 dark:text-amber-400' },
      { to: '/inventory/parts', label: 'Parts catalogue', icon: Package, end: false, permission: 'part.read', color: 'bg-teal-500/15 text-teal-600 dark:text-teal-400' },
    ],
  },
  {
    heading: 'Aftersales & warranty',
    items: [
      { to: '/warranty-claims', label: 'Warranty claims', icon: ShieldCheck, end: false, permission: 'warranty.claim.read', color: 'bg-rose-500/15 text-rose-600 dark:text-rose-400' },
      { to: '/warranties', label: 'Warranties sold', icon: BadgeCheck, end: false, permission: 'customer.read', color: 'bg-teal-500/15 text-teal-600 dark:text-teal-400' },
    ],
  },
  {
    heading: 'Finance',
    items: [
      { to: '/invoices', label: 'Invoices', icon: Receipt, end: false, permission: 'invoice.read', color: 'bg-green-500/15 text-green-600 dark:text-green-400' },
      { to: '/reports', label: 'Reports', icon: BarChart3, end: false, permission: 'accounting.read', color: 'bg-indigo-500/15 text-indigo-600 dark:text-indigo-400' },
    ],
  },
  {
    heading: 'Inventory',
    items: [
      { to: '/inventory', label: 'Stock', icon: Boxes, end: true, permission: 'inventory.read', color: 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400' },
      { to: '/inventory/products', label: 'Products (retail)', icon: ShoppingBag, end: false, permission: 'part.read', color: 'bg-violet-500/15 text-violet-600 dark:text-violet-400' },
      { to: '/inventory/suppliers', label: 'Suppliers', icon: Factory, end: false, permission: 'supplier.read', color: 'bg-cyan-500/15 text-cyan-600 dark:text-cyan-400' },
      { to: '/inventory/purchase-orders', label: 'Purchase orders', icon: ShoppingCart, end: false, permission: 'po.read', color: 'bg-violet-500/15 text-violet-600 dark:text-violet-400' },
      { to: '/inventory/reorder', label: 'Reorder', icon: RefreshCw, end: false, permission: 'po.read', color: 'bg-orange-500/15 text-orange-600 dark:text-orange-400' },
      { to: '/inventory/transfers', label: 'Transfers', icon: ArrowLeftRight, end: false, permission: 'inventory.read', color: 'bg-sky-500/15 text-sky-600 dark:text-sky-400' },
      { to: '/inventory/serial-units', label: 'Serial units', icon: ScanBarcode, end: false, permission: 'inventory.read', color: 'bg-fuchsia-500/15 text-fuchsia-600 dark:text-fuchsia-400' },
      { to: '/inventory/movements', label: 'Movements', icon: Truck, end: false, permission: 'inventory.read', color: 'bg-lime-500/15 text-lime-600 dark:text-lime-500' },
    ],
  },
  {
    heading: 'Oversight',
    items: [
      { to: '/workload', label: 'Right now', icon: Gauge, end: false, permission: 'job.read', color: 'bg-rose-500/15 text-rose-600 dark:text-rose-400' },
      { to: '/operations', label: 'Operations', icon: Activity, end: false, permission: 'job.read', color: 'bg-sky-500/15 text-sky-600 dark:text-sky-400' },
      { to: '/approvals', label: 'Approvals', icon: ClipboardCheck, end: false, permission: 'approval.decide', color: 'bg-amber-500/15 text-amber-600 dark:text-amber-400' },
      { to: '/audit', label: 'Audit log', icon: ScrollText, end: false, permission: 'audit.read', color: 'bg-slate-500/15 text-slate-600 dark:text-slate-300' },
    ],
  },
  {
    heading: 'Administration',
    items: [
      { to: '/admin/company', label: 'Company', icon: Building2, end: false, permission: 'config.read', color: 'bg-purple-500/15 text-purple-600 dark:text-purple-400' },
      { to: '/admin/branches', label: 'Branches', icon: MapPin, end: false, permission: 'config.read', color: 'bg-pink-500/15 text-pink-600 dark:text-pink-400' },
      { to: '/admin/users', label: 'Users', icon: Users, end: false, permission: 'user.read', color: 'bg-blue-500/15 text-blue-600 dark:text-blue-400' },
      { to: '/admin/roles', label: 'Roles & permissions', icon: KeyRound, end: false, permission: 'user.read', color: 'bg-amber-500/15 text-amber-600 dark:text-amber-400' },
      { to: '/admin/config', label: 'Configuration', icon: SlidersHorizontal, end: false, permission: 'config.read', color: 'bg-slate-500/15 text-slate-600 dark:text-slate-300' },
    ],
  },
  {
    heading: 'Account',
    items: [
      { to: '/security', label: 'Security', icon: ShieldCheck, end: false, color: 'bg-red-500/15 text-red-600 dark:text-red-400' },
    ],
  },
]

const ALL_ITEMS = NAV_SECTIONS.flatMap((s) => s.items)

function currentTitle(pathname: string): string {
  const item = ALL_ITEMS.find((i) =>
    i.end ? pathname === i.to : pathname.startsWith(i.to),
  )
  return item?.label ?? 'TriServe'
}

/**
 * App shell (Task 0.7): sidebar navigation gated by the shared
 * ROLE_PERMISSIONS matrix (via useAuth().can) — purely a UX affordance;
 * every API endpoint re-enforces the same permissions server-side.
 */
export function AppShell() {
  // `search` too: the sidebar's active state depends on it (see
  // isEntryActive). Reading window.location instead would not re-render.
  const { pathname, search } = useLocation()
  const { user, can, logout } = useAuth()
  /** Mobile drawer state — the sidebar is a static column from `lg` up. */
  const [navOpen, setNavOpen] = useState(false)

  // Which sidebar sections the user has collapsed (by heading), persisted so
  // the choice survives reloads. Optional and per-user: everything is expanded
  // until you collapse it, which is how you make the whole nav fit without
  // scrolling — hide the sections you don't use.
  const [collapsed, setCollapsed] = useState<Set<string>>(() => {
    try {
      const raw = localStorage.getItem(NAV_COLLAPSED_KEY)
      return new Set<string>(raw ? (JSON.parse(raw) as string[]) : [])
    } catch {
      return new Set()
    }
  })
  function toggleSection(heading: string) {
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(heading)) next.delete(heading)
      else next.add(heading)
      try {
        localStorage.setItem(NAV_COLLAPSED_KEY, JSON.stringify([...next]))
      } catch {
        // Storage unavailable (private mode) — the choice just won't persist.
      }
      return next
    })
  }

  // Close the drawer whenever the route changes (tap a link → navigate → close).
  useEffect(() => {
    setNavOpen(false)
  }, [pathname])

  const sections = NAV_SECTIONS.map((section) => ({
    ...section,
    items: section.items.filter(
      (item) => item.permission === undefined || can(item.permission),
    ),
  })).filter((section) => section.items.length > 0)

  return (
    // Bounded to the viewport so the WINDOW never scrolls — the topbar and the
    // sidebar stay put, and <main> below becomes the single scroll container.
    // This is also what lets the kanban board's h-full layout resolve.
    <div className="flex h-screen overflow-hidden bg-background text-foreground">
      {/* Backdrop — only on mobile, only while the drawer is open */}
      {navOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/50 backdrop-blur-sm lg:hidden"
          onClick={() => setNavOpen(false)}
          aria-hidden
        />
      )}

      {/* Sidebar — fixed slide-in drawer below `lg`, static column from `lg` up */}
      <aside
        className={cn(
          'fixed inset-y-0 left-0 z-50 flex w-[17rem] max-w-[85vw] shrink-0 flex-col border-r bg-card transition-transform duration-200 ease-out',
          'lg:static lg:z-auto lg:w-60 lg:max-w-none lg:translate-x-0',
          navOpen ? 'translate-x-0 shadow-2xl' : '-translate-x-full',
        )}
      >
        <div className="flex h-16 items-center gap-3 px-5">
          <span className="flex size-9 items-center justify-center rounded-xl bg-gradient-to-br from-indigo-500 to-blue-600 text-white shadow-md shadow-blue-600/25">
            <Wrench className="size-5" />
          </span>
          <span className="flex flex-col leading-none">
            <span className="text-lg font-bold tracking-tight">TriServe</span>
            <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
              Service Centre
            </span>
          </span>
          <Button
            variant="ghost"
            size="icon"
            className="ml-auto size-8 lg:hidden"
            onClick={() => setNavOpen(false)}
            aria-label="Close menu"
          >
            <X className="size-5" />
          </Button>
        </div>
        <nav className="flex flex-1 flex-col gap-0.5 overflow-y-auto px-3 pb-3">
          {sections.map((section, idx) => {
            const isCollapsed = section.heading
              ? collapsed.has(section.heading)
              : false
            // Tint a folded section's heading when the current page lives
            // inside it, so collapsing never hides your location.
            const hidesActive =
              isCollapsed && sectionHasActive(section.items, pathname)
            return (
              <div key={section.heading ?? idx} className="flex flex-col gap-0.5">
                {section.heading && (
                  <button
                    type="button"
                    onClick={() => toggleSection(section.heading as string)}
                    aria-expanded={!isCollapsed}
                    className={cn(
                      'flex items-center justify-between rounded-md px-3 pb-1 pt-4 text-[10px] font-semibold uppercase tracking-[0.12em] transition-colors hover:text-foreground',
                      hidesActive ? 'text-primary' : 'text-muted-foreground/70',
                    )}
                  >
                    <span className="flex items-center gap-1.5">
                      {section.heading}
                      {hidesActive && (
                        <span className="size-1.5 rounded-full bg-primary" />
                      )}
                    </span>
                    <ChevronDown
                      className={cn(
                        'size-3.5 transition-transform duration-200',
                        isCollapsed && '-rotate-90',
                      )}
                    />
                  </button>
                )}
                {!isCollapsed &&
                  section.items.map(({ to, label, icon: Icon, end, color }) => (
                    <NavLink
                      key={to}
                      to={to}
                      end={end}
                      className={({ isActive }) =>
                        navItemClass(isEntryActive(isActive, to, search))
                      }
                    >
                      {({ isActive }) => {
                        const active = isEntryActive(isActive, to, search)
                        return (
                          <>
                            {active && (
                              <span className="absolute inset-y-1.5 -left-3 w-1 rounded-r-full bg-primary" />
                            )}
                            <span
                              className={cn(
                                'flex size-7 shrink-0 items-center justify-center rounded-lg transition-transform group-hover:scale-105',
                                color,
                              )}
                            >
                              <Icon className="size-4" />
                            </span>
                            {label}
                          </>
                        )
                      }}
                    </NavLink>
                  ))}
              </div>
            )
          })}
        </nav>
        <div className="flex flex-col gap-3 border-t p-4">
          {user && (
            <div className="flex items-center gap-2.5">
              <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-indigo-500 to-blue-600 text-xs font-semibold text-white shadow-sm">
                {user.full_name
                  .split(' ')
                  .slice(0, 2)
                  .map((n) => n[0])
                  .join('')
                  .toUpperCase()}
              </span>
              <div className="flex min-w-0 flex-col text-xs">
                <span className="truncate font-medium text-foreground">
                  {user.full_name}
                </span>
                <span className="truncate text-muted-foreground">{user.role}</span>
              </div>
            </div>
          )}
          <Button
            variant="outline"
            size="sm"
            className="justify-start gap-2"
            onClick={() => void logout()}
          >
            <LogOut className="size-4" />
            Sign out
          </Button>
        </div>
      </aside>

      {/* Main column */}
      <div className="flex min-w-0 flex-1 flex-col">
        {/* Topbar */}
        <header className="sticky top-0 z-10 flex h-14 items-center justify-between gap-2 border-b bg-background/80 px-4 backdrop-blur sm:px-6">
          <div className="flex min-w-0 items-center gap-2">
            <Button
              variant="outline"
              size="icon"
              className="size-9 lg:hidden"
              onClick={() => setNavOpen(true)}
              aria-label="Open menu"
            >
              <Menu className="size-4" />
            </Button>
            <h1 className="truncate text-base font-semibold">{currentTitle(pathname)}</h1>
          </div>
          <div className="flex shrink-0 items-center gap-3">
            <span className="hidden items-center gap-2 text-sm text-muted-foreground md:flex">
              <span className="size-1.5 rounded-full bg-emerald-500" />
              Samsung Authorized Service Centre
            </span>
            <ThemeToggle />
          </div>
        </header>
        {/* min-h-0 lets flex-1 bound this box so it scrolls internally rather
            than growing the page — the topbar and sidebar stay fixed above/beside it. */}
        <main className="min-h-0 flex-1 overflow-y-auto bg-muted/30 p-4 sm:p-6">
          <Outlet />
        </main>
      </div>
    </div>
  )
}
