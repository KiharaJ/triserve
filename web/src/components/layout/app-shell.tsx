import {
  ArrowLeftRight,
  Boxes,
  Building2,
  ClipboardCheck,
  Factory,
  LayoutDashboard,
  LogOut,
  MapPin,
  Package,
  Receipt,
  RefreshCw,
  ScanBarcode,
  ScrollText,
  ShieldCheck,
  ShoppingCart,
  SlidersHorizontal,
  Truck,
  Users,
  Wrench,
} from 'lucide-react'
import { NavLink, Outlet, useLocation } from 'react-router-dom'
import type { Permission } from '@triserve/shared'
import { Button } from '@/components/ui/button'
import { useAuth } from '@/lib/auth'
import { cn } from '@/lib/utils'

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

const NAV_SECTIONS: NavSection[] = [
  {
    items: [
      { to: '/', label: 'Dashboard', icon: LayoutDashboard, end: true, color: 'bg-indigo-500/15 text-indigo-600 dark:text-indigo-400' },
      { to: '/jobs', label: 'Jobs', icon: Wrench, end: false, permission: 'job.read', color: 'bg-blue-500/15 text-blue-600 dark:text-blue-400' },
      { to: '/approvals', label: 'Approvals', icon: ClipboardCheck, end: false, permission: 'approval.decide', color: 'bg-amber-500/15 text-amber-600 dark:text-amber-400' },
      { to: '/audit', label: 'Audit log', icon: ScrollText, end: false, permission: 'audit.read', color: 'bg-slate-500/15 text-slate-600 dark:text-slate-300' },
    ],
  },
  {
    heading: 'Inventory',
    items: [
      { to: '/inventory', label: 'Stock', icon: Boxes, end: true, permission: 'inventory.read', color: 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400' },
      { to: '/inventory/parts', label: 'Parts catalogue', icon: Package, end: false, permission: 'part.read', color: 'bg-teal-500/15 text-teal-600 dark:text-teal-400' },
      { to: '/inventory/suppliers', label: 'Suppliers', icon: Factory, end: false, permission: 'supplier.read', color: 'bg-cyan-500/15 text-cyan-600 dark:text-cyan-400' },
      { to: '/inventory/purchase-orders', label: 'Purchase orders', icon: ShoppingCart, end: false, permission: 'po.read', color: 'bg-violet-500/15 text-violet-600 dark:text-violet-400' },
      { to: '/inventory/reorder', label: 'Reorder', icon: RefreshCw, end: false, permission: 'po.read', color: 'bg-orange-500/15 text-orange-600 dark:text-orange-400' },
      { to: '/inventory/transfers', label: 'Transfers', icon: ArrowLeftRight, end: false, permission: 'inventory.read', color: 'bg-sky-500/15 text-sky-600 dark:text-sky-400' },
      { to: '/inventory/serial-units', label: 'Serial units', icon: ScanBarcode, end: false, permission: 'inventory.read', color: 'bg-fuchsia-500/15 text-fuchsia-600 dark:text-fuchsia-400' },
      { to: '/inventory/movements', label: 'Movements', icon: Truck, end: false, permission: 'inventory.read', color: 'bg-lime-500/15 text-lime-600 dark:text-lime-500' },
    ],
  },
  {
    heading: 'Sales',
    items: [
      { to: '/invoices', label: 'Invoices', icon: Receipt, end: false, permission: 'invoice.read', color: 'bg-green-500/15 text-green-600 dark:text-green-400' },
      { to: '/warranty-claims', label: 'Warranty claims', icon: ShieldCheck, end: false, permission: 'warranty.claim.read', color: 'bg-rose-500/15 text-rose-600 dark:text-rose-400' },
    ],
  },
  {
    heading: 'Administration',
    items: [
      { to: '/admin/company', label: 'Company', icon: Building2, end: false, permission: 'config.read', color: 'bg-purple-500/15 text-purple-600 dark:text-purple-400' },
      { to: '/admin/branches', label: 'Branches', icon: MapPin, end: false, permission: 'config.read', color: 'bg-pink-500/15 text-pink-600 dark:text-pink-400' },
      { to: '/admin/users', label: 'Users', icon: Users, end: false, permission: 'user.read', color: 'bg-blue-500/15 text-blue-600 dark:text-blue-400' },
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
  const { pathname } = useLocation()
  const { user, can, logout } = useAuth()

  const sections = NAV_SECTIONS.map((section) => ({
    ...section,
    items: section.items.filter(
      (item) => item.permission === undefined || can(item.permission),
    ),
  })).filter((section) => section.items.length > 0)

  return (
    <div className="flex min-h-screen bg-background text-foreground">
      {/* Sidebar */}
      <aside className="flex w-60 shrink-0 flex-col border-r bg-card">
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
        </div>
        <nav className="flex flex-1 flex-col gap-0.5 overflow-y-auto px-3 pb-3">
          {sections.map((section, idx) => (
            <div key={section.heading ?? idx} className="flex flex-col gap-0.5">
              {section.heading && (
                <span className="px-3 pb-1 pt-4 text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground/70">
                  {section.heading}
                </span>
              )}
              {section.items.map(({ to, label, icon: Icon, end, color }) => (
                <NavLink
                  key={to}
                  to={to}
                  end={end}
                  className={({ isActive }) =>
                    cn(
                      'group relative flex items-center gap-3 rounded-lg px-2.5 py-1.5 text-sm font-medium transition-all',
                      isActive
                        ? 'bg-accent text-foreground'
                        : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground',
                    )
                  }
                >
                  {({ isActive }) => (
                    <>
                      {isActive && (
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
                  )}
                </NavLink>
              ))}
            </div>
          ))}
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
        <header className="sticky top-0 z-10 flex h-14 items-center justify-between border-b bg-background/80 px-6 backdrop-blur">
          <h1 className="text-base font-semibold">{currentTitle(pathname)}</h1>
          <span className="flex items-center gap-2 text-sm text-muted-foreground">
            <span className="hidden size-1.5 rounded-full bg-emerald-500 sm:inline-block" />
            Samsung Authorized Service Centre
          </span>
        </header>
        <main className="flex-1 overflow-y-auto bg-muted/30 p-6">
          <Outlet />
        </main>
      </div>
    </div>
  )
}
