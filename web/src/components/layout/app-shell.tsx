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
      { to: '/', label: 'Dashboard', icon: LayoutDashboard, end: true },
      { to: '/jobs', label: 'Jobs', icon: Wrench, end: false, permission: 'job.read' },
      {
        to: '/approvals',
        label: 'Approvals',
        icon: ClipboardCheck,
        end: false,
        permission: 'approval.decide',
      },
      {
        to: '/audit',
        label: 'Audit log',
        icon: ScrollText,
        end: false,
        permission: 'audit.read',
      },
    ],
  },
  {
    heading: 'Inventory',
    items: [
      {
        to: '/inventory',
        label: 'Stock',
        icon: Boxes,
        end: true,
        permission: 'inventory.read',
      },
      {
        to: '/inventory/parts',
        label: 'Parts catalogue',
        icon: Package,
        end: false,
        permission: 'part.read',
      },
      {
        to: '/inventory/suppliers',
        label: 'Suppliers',
        icon: Factory,
        end: false,
        permission: 'supplier.read',
      },
      {
        to: '/inventory/purchase-orders',
        label: 'Purchase orders',
        icon: ShoppingCart,
        end: false,
        permission: 'po.read',
      },
      {
        to: '/inventory/reorder',
        label: 'Reorder',
        icon: RefreshCw,
        end: false,
        permission: 'po.read',
      },
      {
        to: '/inventory/transfers',
        label: 'Transfers',
        icon: ArrowLeftRight,
        end: false,
        permission: 'inventory.read',
      },
      {
        to: '/inventory/serial-units',
        label: 'Serial units',
        icon: ScanBarcode,
        end: false,
        permission: 'inventory.read',
      },
      {
        to: '/inventory/movements',
        label: 'Movements',
        icon: Truck,
        end: false,
        permission: 'inventory.read',
      },
    ],
  },
  {
    heading: 'Sales',
    items: [
      {
        to: '/invoices',
        label: 'Invoices',
        icon: Receipt,
        end: false,
        permission: 'invoice.read',
      },
      {
        to: '/warranty-claims',
        label: 'Warranty claims',
        icon: ShieldCheck,
        end: false,
        permission: 'warranty.claim.read',
      },
    ],
  },
  {
    heading: 'Administration',
    items: [
      {
        to: '/admin/company',
        label: 'Company',
        icon: Building2,
        end: false,
        permission: 'config.read',
      },
      {
        to: '/admin/branches',
        label: 'Branches',
        icon: MapPin,
        end: false,
        permission: 'config.read',
      },
      {
        to: '/admin/users',
        label: 'Users',
        icon: Users,
        end: false,
        permission: 'user.read',
      },
      {
        to: '/admin/config',
        label: 'Configuration',
        icon: SlidersHorizontal,
        end: false,
        permission: 'config.read',
      },
    ],
  },
  {
    heading: 'Account',
    items: [
      { to: '/security', label: 'Security', icon: ShieldCheck, end: false },
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
      <aside className="flex w-60 shrink-0 flex-col bg-gradient-to-b from-[#182a9c] via-[#101d78] to-[#0a1250] text-white shadow-xl">
        <div className="flex h-16 items-center gap-3 px-5">
          <span className="flex size-9 items-center justify-center rounded-xl bg-white text-[#101d78] shadow-md ring-1 ring-white/40">
            <Wrench className="size-5" />
          </span>
          <span className="flex flex-col leading-none">
            <span className="text-lg font-bold tracking-tight">TriServe</span>
            <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-sky-200/80">
              Service Centre
            </span>
          </span>
        </div>
        <nav className="flex flex-1 flex-col gap-0.5 overflow-y-auto px-3 pb-3">
          {sections.map((section, idx) => (
            <div key={section.heading ?? idx} className="flex flex-col gap-0.5">
              {section.heading && (
                <span className="px-3 pb-1 pt-4 text-[10px] font-semibold uppercase tracking-[0.12em] text-white/40">
                  {section.heading}
                </span>
              )}
              {section.items.map(({ to, label, icon: Icon, end }) => (
                <NavLink
                  key={to}
                  to={to}
                  end={end}
                  className={({ isActive }) =>
                    cn(
                      'group relative flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-all',
                      isActive
                        ? 'bg-white/15 text-white shadow-sm'
                        : 'text-sky-100/70 hover:bg-white/10 hover:text-white',
                    )
                  }
                >
                  {({ isActive }) => (
                    <>
                      {isActive && (
                        <span className="absolute inset-y-1.5 left-0 w-1 rounded-full bg-sky-300" />
                      )}
                      <Icon
                        className={cn(
                          'size-4 shrink-0 transition-colors',
                          isActive
                            ? 'text-sky-300'
                            : 'text-sky-200/60 group-hover:text-white',
                        )}
                      />
                      {label}
                    </>
                  )}
                </NavLink>
              ))}
            </div>
          ))}
        </nav>
        <div className="flex flex-col gap-3 border-t border-white/10 p-4">
          {user && (
            <div className="flex items-center gap-2.5">
              <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-white/15 text-xs font-semibold text-white">
                {user.full_name
                  .split(' ')
                  .slice(0, 2)
                  .map((n) => n[0])
                  .join('')
                  .toUpperCase()}
              </span>
              <div className="flex min-w-0 flex-col text-xs">
                <span className="truncate font-medium text-white">
                  {user.full_name}
                </span>
                <span className="truncate text-sky-200/60">{user.role}</span>
              </div>
            </div>
          )}
          <Button
            variant="outline"
            size="sm"
            className="justify-start gap-2 border-white/25 bg-transparent text-white hover:bg-white/15 hover:text-white"
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
