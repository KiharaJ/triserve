import { LayoutDashboard, Settings, Wrench } from 'lucide-react'
import { NavLink, Outlet, useLocation } from 'react-router-dom'
import { Separator } from '@/components/ui/separator'
import { cn } from '@/lib/utils'

const NAV_ITEMS = [
  { to: '/', label: 'Dashboard', icon: LayoutDashboard, end: true },
  { to: '/jobs', label: 'Jobs', icon: Wrench, end: false },
  { to: '/admin', label: 'Admin', icon: Settings, end: false },
]

function currentTitle(pathname: string): string {
  const item = NAV_ITEMS.find((i) =>
    i.end ? pathname === i.to : pathname.startsWith(i.to),
  )
  return item?.label ?? 'TriServe'
}

export function AppShell() {
  const { pathname } = useLocation()

  return (
    <div className="flex min-h-screen bg-background text-foreground">
      {/* Sidebar */}
      <aside className="flex w-56 shrink-0 flex-col border-r bg-sidebar text-sidebar-foreground">
        <div className="flex h-14 items-center px-4">
          <span className="text-lg font-semibold tracking-tight">TriServe</span>
        </div>
        <Separator />
        <nav className="flex flex-1 flex-col gap-1 p-2">
          {NAV_ITEMS.map(({ to, label, icon: Icon, end }) => (
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
        </nav>
        <Separator />
        <div className="p-4 text-xs text-muted-foreground">
          Tristate Systems Ltd
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
