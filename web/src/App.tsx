import { Route, Routes } from 'react-router-dom'
import { AppShell } from '@/components/layout/app-shell'
import { AdminPage } from '@/pages/admin'
import { DashboardPage } from '@/pages/dashboard'
import { JobsPage } from '@/pages/jobs'

function App() {
  return (
    <Routes>
      <Route element={<AppShell />}>
        <Route index element={<DashboardPage />} />
        <Route path="jobs" element={<JobsPage />} />
        <Route path="admin" element={<AdminPage />} />
      </Route>
    </Routes>
  )
}

export default App
