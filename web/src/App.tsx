import { Navigate, Route, Routes, useLocation } from 'react-router-dom'
import type { ReactNode } from 'react'
import { AppShell } from '@/components/layout/app-shell'
import { useAuth } from '@/lib/auth'
import { BranchesPage } from '@/pages/admin/branches'
import { CompanyPage } from '@/pages/admin/company'
import { ConfigPage } from '@/pages/admin/config'
import { UsersPage } from '@/pages/admin/users'
import { ApprovalsPage } from '@/pages/approvals'
import { AuditPage } from '@/pages/audit'
import { CustomerDetailPage } from '@/pages/customers/detail'
import { DashboardPage } from '@/pages/dashboard'
import { MovementsPage } from '@/pages/inventory/movements'
import { PartsPage } from '@/pages/inventory/parts'
import { StockPage } from '@/pages/inventory/stock'
import { TransfersPage } from '@/pages/inventory/transfers'
import { JobsBoardPage } from '@/pages/jobs/board'
import { JobDetailPage } from '@/pages/jobs/detail'
import { JobIntakePage } from '@/pages/jobs/intake'
import { LoginPage } from '@/pages/login'
import { SecurityPage } from '@/pages/security'

/** Everything behind here requires a session; anonymous users go to /login. */
function RequireAuth({ children }: { children: ReactNode }) {
  const { status } = useAuth()
  const location = useLocation()

  if (status === 'loading') {
    return (
      <div className="flex min-h-screen items-center justify-center text-sm text-muted-foreground">
        Loading…
      </div>
    )
  }
  if (status === 'anonymous') {
    return (
      <Navigate
        to="/login"
        replace
        state={{ from: location.pathname + location.search }}
      />
    )
  }
  return children
}

function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route
        element={
          <RequireAuth>
            <AppShell />
          </RequireAuth>
        }
      >
        <Route index element={<DashboardPage />} />
        <Route path="jobs">
          <Route index element={<JobsBoardPage />} />
          <Route path="new" element={<JobIntakePage />} />
          <Route path=":id" element={<JobDetailPage />} />
        </Route>
        <Route path="customers/:id" element={<CustomerDetailPage />} />
        <Route path="inventory">
          <Route index element={<StockPage />} />
          <Route path="parts" element={<PartsPage />} />
          <Route path="transfers" element={<TransfersPage />} />
          <Route path="movements" element={<MovementsPage />} />
        </Route>
        <Route path="approvals" element={<ApprovalsPage />} />
        <Route path="audit" element={<AuditPage />} />
        <Route path="security" element={<SecurityPage />} />
        <Route path="admin">
          <Route index element={<Navigate to="/admin/company" replace />} />
          <Route path="company" element={<CompanyPage />} />
          <Route path="branches" element={<BranchesPage />} />
          <Route path="users" element={<UsersPage />} />
          <Route path="config" element={<ConfigPage />} />
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  )
}

export default App
