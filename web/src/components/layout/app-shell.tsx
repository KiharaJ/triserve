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
import { Separator } from '@/components/ui/separator'
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
      <aside className="flex w-56 shrink-0 flex-col border-r bg-sidebar text-sidebar-foreground">
        <div className="flex h-14 items-center px-4">
          <span className="text-lg font-semibold tracking-tight">TriServe</span>
        </div>
        <Separator />
        <nav className="flex flex-1 flex-col gap-1 overflow-y-auto p-2">
          {sections.map((section, idx) => (
            <div key={section.heading ?? idx} className="flex flex-col gap-1">
              {section.heading && (
                <span className="px-3 pb-1 pt-3 text-xs font-medium uppercase tracking-wide text-muted-foreground">
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
                      'flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors',
                      isActive
                        ? 'bg-sidebar-accent text-sidebar-accent-foreground'
                        : 'text-muted-foreground hover:bg-sidebar-accent/50 hover:text-sidebar-accent-foreground',
                    )
                  }
                >
                  <Icon className="size-4" />
                  {label}
                </NavLink>
              ))}
            </div>
          ))}
        </nav>
        <Separator />
        <div className="flex flex-col gap-2 p-4">
          {user && (
            <div className="flex flex-col text-xs">
              <span className="font-medium text-foreground">
                {user.full_name}
              </span>
              <span className="text-muted-foreground">{user.role}</span>
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
        <header className="flex h-14 items-center justify-between border-b px-6">
          <h1 className="text-base font-semibold">{currentTitle(pathname)}</h1>
          <span className="text-sm text-muted-foreground">
            Samsung Authorized Service Centre
          </span>
        </header>
        <main className="flex-1 overflow-y-auto p-6">
          <Outlet />
        </main>
      </div>
    </div>
  )
}
