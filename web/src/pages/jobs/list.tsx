import { useQuery } from '@tanstack/react-query'
import { Plus, Search } from 'lucide-react'
import { useState } from 'react'
import { Link } from 'react-router-dom'
import type { PaginatedResponse } from '@triserve/shared'
import { Pager } from '@/components/shared/pager'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { Input } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
import { api, apiErrorMessage } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { formatAge, formatDate } from '@/lib/format'
import { useByIds } from '@/lib/use-by-ids'
import { useDebouncedValue } from '@/lib/use-debounced-value'
import type {
  BranchWire,
  CustomerWire,
  DeviceWire,
  JobWire,
  UserWire,
  WarrantyStatus,
  WorkflowGraphWire,
} from '@/lib/types'

const WARRANTY_STATUSES: WarrantyStatus[] = ['IW', 'OW', 'GOODWILL', 'UNKNOWN']

function warrantyBadge(status: WarrantyStatus) {
  switch (status) {
    case 'IW':
      return <Badge variant="success">IW</Badge>
    case 'OW':
      return <Badge variant="warning">OW</Badge>
    case 'GOODWILL':
      return <Badge variant="secondary">Goodwill</Badge>
    default:
      return <Badge variant="outline">Unknown</Badge>
  }
}

/**
 * Jobs list view (Phase 5 UX): a scannable, paginated table — the default now
 * that a branch can hold thousands of jobs (a Kanban board only fits ~a screen
 * and one page). Filter by branch/engineer/warranty/state + free-text search;
 * the board remains available via the view toggle for workflow management.
 */
export function JobsListView() {
  const { user, can } = useAuth()
  const [page, setPage] = useState(1)
  const [branchId, setBranchId] = useState('')
  const [engineerId, setEngineerId] = useState('')
  const [warrantyStatus, setWarrantyStatus] = useState('')
  const [state, setState] = useState('')
  const [search, setSearch] = useState('')
  const debouncedSearch = useDebouncedValue(search, 350)

  const graph = useQuery({
    queryKey: ['workflow-graph'],
    queryFn: async () =>
      (await api.get<WorkflowGraphWire>('/workflow/graph')).data,
  })

  const jobsQuery = useQuery({
    queryKey: [
      'jobs-list',
      page,
      branchId,
      engineerId,
      warrantyStatus,
      state,
      debouncedSearch,
    ],
    queryFn: async () =>
      (
        await api.get<PaginatedResponse<JobWire>>('/jobs', {
          params: {
            page,
            page_size: 20,
            ...(branchId ? { branch_id: branchId } : {}),
            ...(engineerId ? { assigned_engineer_id: engineerId } : {}),
            ...(warrantyStatus ? { warranty_status: warrantyStatus } : {}),
            ...(state ? { state } : {}),
            ...(debouncedSearch ? { q: debouncedSearch } : {}),
          },
        })
      ).data,
  })
  const jobs = jobsQuery.data?.data ?? []

  const branches = useQuery({
    queryKey: ['branches', 'all'],
    enabled: user?.scope === 'group' && can('config.read'),
    queryFn: async () =>
      (await api.get<PaginatedResponse<BranchWire>>('/branches', { params: { page_size: 100 } })).data
        .data,
  })

  const technicians = useQuery({
    queryKey: ['users', 'technicians'],
    enabled: can('user.read') && user?.role !== 'TECHNICIAN',
    queryFn: async () =>
      (
        await api.get<PaginatedResponse<UserWire>>('/users', {
          params: { role: 'TECHNICIAN', active: true, page_size: 100 },
        })
      ).data.data,
  })

  const customers = useByIds<CustomerWire>('customers', jobs.map((j) => j.customer_id))
  const devices = useByIds<DeviceWire>('devices', jobs.map((j) => j.device_id))
  const engineers = useByIds<UserWire>(
    'users',
    jobs.map((j) => j.assigned_engineer_id),
    can('user.read'),
  )

  function resetPage<T>(setter: (v: T) => void) {
    return (v: T) => {
      setter(v)
      setPage(1)
    }
  }

  const states = (graph.data?.states ?? []).filter((s) => s.active)

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative w-56">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Search job#, phone, IMEI…"
            value={search}
            onChange={(e) => resetPage(setSearch)(e.target.value)}
            className="pl-8"
          />
        </div>
        {branches.data && branches.data.length > 0 && (
          <Select
            value={branchId}
            onChange={(e) => resetPage(setBranchId)(e.target.value)}
            className="w-36"
            aria-label="Filter by branch"
          >
            <option value="">All branches</option>
            {branches.data.map((b) => (
              <option key={b.id} value={b.id}>
                {b.code}
              </option>
            ))}
          </Select>
        )}
        <Select
          value={state}
          onChange={(e) => resetPage(setState)(e.target.value)}
          className="w-44"
          aria-label="Filter by state"
        >
          <option value="">All states</option>
          {states.map((s) => (
            <option key={s.code} value={s.code}>
              {s.label}
            </option>
          ))}
        </Select>
        {technicians.data && user?.role !== 'TECHNICIAN' && (
          <Select
            value={engineerId}
            onChange={(e) => resetPage(setEngineerId)(e.target.value)}
            className="w-44"
            aria-label="Filter by engineer"
          >
            <option value="">All engineers</option>
            {technicians.data.map((t) => (
              <option key={t.id} value={t.id}>
                {t.full_name}
              </option>
            ))}
          </Select>
        )}
        <Select
          value={warrantyStatus}
          onChange={(e) => resetPage(setWarrantyStatus)(e.target.value)}
          className="w-32"
          aria-label="Filter by warranty status"
        >
          <option value="">All warranty</option>
          {WARRANTY_STATUSES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </Select>
        <div className="flex-1" />
        {can('job.create') && (
          <Button asChild size="sm" className="gap-1.5">
            <Link to="/jobs/new">
              <Plus className="size-4" /> New job
            </Link>
          </Button>
        )}
      </div>

      {jobsQuery.isError && (
        <p className="text-sm text-destructive">{apiErrorMessage(jobsQuery.error)}</p>
      )}
      {jobsQuery.isPending && (
        <p className="text-sm text-muted-foreground">Loading…</p>
      )}
      {jobsQuery.data && (
        <div className="overflow-hidden rounded-xl border bg-card shadow-sm">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Job #</TableHead>
                <TableHead>Customer</TableHead>
                <TableHead>Device</TableHead>
                <TableHead>State</TableHead>
                <TableHead>Warranty</TableHead>
                <TableHead>Engineer</TableHead>
                <TableHead className="text-right">Received</TableHead>
                <TableHead className="text-right">Age</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {jobs.length === 0 && (
                <TableRow>
                  <TableCell colSpan={8} className="py-10 text-center text-muted-foreground">
                    No jobs match these filters.
                  </TableCell>
                </TableRow>
              )}
              {jobs.map((j) => {
                const device = devices.get(j.device_id)
                const engineer = j.assigned_engineer_id
                  ? engineers.get(j.assigned_engineer_id)
                  : undefined
                return (
                  <TableRow key={j.id}>
                    <TableCell>
                      <Link
                        to={`/jobs/${j.id}`}
                        className="font-mono text-sm font-medium text-primary hover:underline"
                      >
                        {j.job_no}
                      </Link>
                    </TableCell>
                    <TableCell className="max-w-40 truncate">
                      {customers.get(j.customer_id)?.name ?? '—'}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {device?.model ?? device?.brand ?? '—'}
                      {device?.imei_serial ? (
                        <span className="ml-1 font-mono text-xs">
                          ·{device.imei_serial.slice(-6)}
                        </span>
                      ) : null}
                    </TableCell>
                    <TableCell>
                      <Badge variant="info">{j.state_label}</Badge>
                    </TableCell>
                    <TableCell>{warrantyBadge(j.warranty_status)}</TableCell>
                    <TableCell>
                      {engineer ? (
                        <Badge variant="outline" title={engineer.full_name}>
                          {engineer.initials ??
                            engineer.full_name.slice(0, 2).toUpperCase()}
                        </Badge>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </TableCell>
                    <TableCell className="text-right text-muted-foreground">
                      {formatDate(j.received_at)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums text-muted-foreground">
                      {formatAge(j.received_at)}
                    </TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
          <div className="border-t px-4 py-3">
            <Pager
              page={jobsQuery.data.page}
              pageSize={jobsQuery.data.page_size}
              total={jobsQuery.data.total}
              onPageChange={setPage}
            />
          </div>
        </div>
      )}
    </div>
  )
}
