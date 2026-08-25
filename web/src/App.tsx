import { Navigate, Route, Routes, useLocation } from 'react-router-dom'
import type { ReactNode } from 'react'
import { AppShell } from '@/components/layout/app-shell'
import { useAuth } from '@/lib/auth'
import { BranchesPage } from '@/pages/admin/branches'
import { CompanyPage } from '@/pages/admin/company'
import { ConfigPage } from '@/pages/admin/config'
import { IntakeConfigPage } from '@/pages/admin/intake-config'
import { RolesPage } from '@/pages/admin/roles'
import { SkillsPage } from '@/pages/admin/skills'
import { UsersPage } from '@/pages/admin/users'
import { ApprovalsPage } from '@/pages/approvals'
import { AuditPage } from '@/pages/audit'
import { CustomerDetailPage } from '@/pages/customers/detail'
import { CustomersListPage } from '@/pages/customers/list'
import { DevicesListPage } from '@/pages/devices/list'
import { DashboardPage } from '@/pages/dashboard'
import { GuidePage } from '@/pages/guide'
import { WorkloadPage } from '@/pages/workload'
import { MovementsPage } from '@/pages/inventory/movements'
import { PartsPage } from '@/pages/inventory/parts'
import { ProductsPage } from '@/pages/inventory/products'
import { PurchaseOrdersPage } from '@/pages/inventory/purchase-orders'
import { ReorderPage } from '@/pages/inventory/reorder'
import { SerialUnitsPage } from '@/pages/inventory/serial-units'
import { StockPage } from '@/pages/inventory/stock'
import { SuppliersPage } from '@/pages/inventory/suppliers'
import { TransfersPage } from '@/pages/inventory/transfers'
import { JobDetailPage } from '@/pages/jobs/detail'
import { JobsPage } from '@/pages/jobs'
import { JobIntakePage } from '@/pages/jobs/intake'
import { LoginPage } from '@/pages/login'
import { ConsignmentsPage } from '@/pages/logistics/consignments'
import { CommsLogPage } from '@/pages/oversight/comms-log'
import { PublicCsatPage } from '@/pages/public/csat'
import { PublicQuotePage } from '@/pages/public/quote-approval'
import { SwapStockPage } from '@/pages/workshop/swap-stock'
import { InvoicesPage } from '@/pages/pos/invoices'
import { OperationsPage } from '@/pages/operations'
import { ReportsPage } from '@/pages/reports'
import { SecurityPage } from '@/pages/security'
import { WarrantyClaimsPage } from '@/pages/warranty/claims'
import { WarrantyRegistrationsPage } from '@/pages/warranty/registrations'

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
      {/* Customer-facing and UNAUTHENTICATED — outside RequireAuth and the
          AppShell on purpose. The recipient has no TriServe account; the
          token in the URL is the credential. Sending them to /login would
          kill both flows. */}
      <Route path="/quote/:token" element={<PublicQuotePage />} />
      <Route path="/csat/:token" element={<PublicCsatPage />} />
      <Route
        element={
          <RequireAuth>
            <AppShell />
          </RequireAuth>
        }
      >
        <Route index element={<DashboardPage />} />
        <Route path="guide" element={<GuidePage />} />
        <Route path="jobs">
          <Route index element={<JobsPage />} />
          <Route path="new" element={<JobIntakePage />} />
          <Route path=":id" element={<JobDetailPage />} />
        </Route>
        <Route path="customers" element={<CustomersListPage />} />
        <Route path="customers/:id" element={<CustomerDetailPage />} />
        <Route path="devices" element={<DevicesListPage />} />
        <Route path="inventory">
          <Route index element={<StockPage />} />
          <Route path="parts" element={<PartsPage />} />
          <Route path="products" element={<ProductsPage />} />
          <Route path="suppliers" element={<SuppliersPage />} />
          <Route path="purchase-orders" element={<PurchaseOrdersPage />} />
          <Route path="reorder" element={<ReorderPage />} />
          <Route path="serial-units" element={<SerialUnitsPage />} />
          <Route path="transfers" element={<TransfersPage />} />
          <Route path="movements" element={<MovementsPage />} />
        </Route>
        <Route path="invoices" element={<InvoicesPage />} />
        <Route path="warranty-claims" element={<WarrantyClaimsPage />} />
        <Route path="warranties" element={<WarrantyRegistrationsPage />} />
        <Route path="reports" element={<ReportsPage />} />
        <Route path="workload" element={<WorkloadPage />} />
        <Route path="operations" element={<OperationsPage />} />
        <Route path="approvals" element={<ApprovalsPage />} />
        <Route path="audit" element={<AuditPage />} />
        <Route path="consignments" element={<ConsignmentsPage />} />
        <Route path="swap-stock" element={<SwapStockPage />} />
        <Route path="comms" element={<CommsLogPage />} />
        <Route path="security" element={<SecurityPage />} />
        <Route path="admin">
          <Route index element={<Navigate to="/admin/company" replace />} />
          <Route path="company" element={<CompanyPage />} />
          <Route path="branches" element={<BranchesPage />} />
          <Route path="users" element={<UsersPage />} />
          <Route path="roles" element={<RolesPage />} />
          <Route path="config" element={<ConfigPage />} />
          <Route path="intake-config" element={<IntakeConfigPage />} />
          <Route path="skills" element={<SkillsPage />} />
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  )
}

export default App
