import {
  DndContext,
  DragOverlay,
  PointerSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from '@dnd-kit/core'
import { useQuery } from '@tanstack/react-query'
import { Plus, Search } from 'lucide-react'
import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import type { PaginatedResponse } from '@triserve/shared'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
import { api, apiErrorMessage } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { useByIds } from '@/lib/use-by-ids'
import { useDebouncedValue } from '@/lib/use-debounced-value'
import { useJobTransition } from '@/pages/jobs/use-job-transition'
import { formatAge } from '@/lib/format'
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
const JOBS_QUERY_ROOT = 'jobs-board'

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

interface CardProps {
  job: JobWire
  customer?: CustomerWire
  device?: DeviceWire
  engineer?: UserWire
  dragging?: boolean
}

function JobCard({ job, customer, device, engineer, dragging }: CardProps) {
  return (
    <div
      className={
        'flex flex-col gap-1.5 rounded-lg border bg-card p-3 text-sm shadow-xs' +
        (dragging ? ' opacity-50' : '')
      }
    >
      <div className="flex items-center justify-between gap-2">
        <Link
          to={`/jobs/${job.id}`}
          className="font-medium text-foreground hover:underline"
          // Dragging is initiated on the card wrapper; stop the drag
          // listeners from swallowing a plain click-through to the link.
          onPointerDown={(e) => e.stopPropagation()}
        >
          {job.job_no}
        </Link>
        {warrantyBadge(job.warranty_status)}
      </div>
      <div className="text-muted-foreground">
        {device?.model ?? device?.brand ?? '—'}
        {device?.imei_serial ? ` · ${device.imei_serial.slice(-6)}` : ''}
      </div>
      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span className="truncate">{customer?.name ?? '—'}</span>
        <span className="flex items-center gap-2">
          {engineer && (
            <Badge variant="outline" title={engineer.full_name}>
              {engineer.initials ?? engineer.full_name.slice(0, 2).toUpperCase()}
            </Badge>
          )}
          <span>{formatAge(job.received_at)}</span>
        </span>
      </div>
    </div>
  )
}

function DraggableCard(props: CardProps) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: props.job.id,
  })
  return (
    <div ref={setNodeRef} {...listeners} {...attributes} className="touch-none">
      <JobCard {...props} dragging={isDragging} />
    </div>
  )
}

function Column({
  code,
  label,
  isTerminal,
  jobs,
  customers,
  devices,
  engineers,
}: {
  code: string
  label: string
  isTerminal: boolean
  jobs: JobWire[]
  customers: Map<string, CustomerWire>
  devices: Map<string, DeviceWire>
  engineers: Map<string, UserWire>
}) {
  const { setNodeRef, isOver } = useDroppable({ id: code })
  return (
    <div
      ref={setNodeRef}
      className={
        'flex w-72 shrink-0 flex-col gap-2 rounded-xl border bg-muted/30 p-2' +
        (isOver ? ' ring-2 ring-ring' : '') +
        (isTerminal ? ' opacity-80' : '')
      }
    >
      <div className="flex items-center justify-between px-1 pt-1">
        <span className="text-sm font-semibold">{label}</span>
        <Badge variant={isTerminal ? 'secondary' : 'outline'}>{jobs.length}</Badge>
      </div>
      <div className="flex min-h-16 flex-col gap-2 overflow-y-auto pb-1">
        {jobs.map((job) => (
          <DraggableCard
            key={job.id}
            job={job}
            customer={customers.get(job.customer_id)}
            device={devices.get(job.device_id)}
            engineer={job.assigned_engineer_id ? engineers.get(job.assigned_engineer_id) : undefined}
          />
        ))}
        {jobs.length === 0 && (
          <p className="px-1 py-2 text-xs text-muted-foreground">No jobs</p>
        )}
      </div>
    </div>
  )
}

/**
 * Job board / Kanban (Task 1.5, DESIGN.md §8 item 4). Columns come from
 * GET /workflow/graph (never hardcoded) so a company's configured lifecycle
 * (§4.10/E7) drives the board directly. Dragging a card calls
 * POST /jobs/{id}/transition; illegal/unauthorized moves show the server's
 * 422 reason and snap back (via query invalidation), and requires_approval
 * moves are announced as "held for approval" — the job's column doesn't
 * change since the state itself is unchanged until a manager decides.
 */
export function JobsBoardPage() {
  const { user, can } = useAuth()
  const [branchId, setBranchId] = useState('')
  const [engineerId, setEngineerId] = useState('')
  const [warrantyStatus, setWarrantyStatus] = useState('')
  const [search, setSearch] = useState('')
  const debouncedSearch = useDebouncedValue(search, 350)
  const [activeJobId, setActiveJobId] = useState<string | null>(null)

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }))

  const graph = useQuery({
    queryKey: ['workflow-graph'],
    queryFn: async () => (await api.get<WorkflowGraphWire>('/workflow/graph')).data,
  })

  const jobsQueryKey = [
    JOBS_QUERY_ROOT,
    branchId,
    engineerId,
    warrantyStatus,
    debouncedSearch,
  ]
  const jobsQuery = useQuery({
    queryKey: jobsQueryKey,
    queryFn: async () =>
      (
        await api.get<PaginatedResponse<JobWire>>('/jobs', {
          params: {
            page_size: 100,
            ...(branchId ? { branch_id: branchId } : {}),
            ...(engineerId ? { assigned_engineer_id: engineerId } : {}),
            ...(warrantyStatus ? { warranty_status: warrantyStatus } : {}),
            ...(debouncedSearch ? { q: debouncedSearch } : {}),
          },
        })
      ).data,
  })
  const jobs = useMemo(() => jobsQuery.data?.data ?? [], [jobsQuery.data])

  // Group users only — branch is fixed for branch-scoped staff.
  const branches = useQuery({
    queryKey: ['branches', 'all'],
    enabled: user?.scope === 'group' && can('config.read'),
    queryFn: async () =>
      (await api.get<PaginatedResponse<BranchWire>>('/branches', { params: { page_size: 100 } })).data
        .data,
  })

  // Technicians ALWAYS see only their own jobs server-side, so this filter
  // is moot (and hidden) for that role.
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

  const customerIds = jobs.map((j) => j.customer_id)
  const deviceIds = jobs.map((j) => j.device_id)
  const engineerIds = jobs.map((j) => j.assigned_engineer_id)
  const customers = useByIds<CustomerWire>('customers', customerIds)
  const devices = useByIds<DeviceWire>('devices', deviceIds)
  const engineers = useByIds<UserWire>('users', engineerIds, can('user.read'))

  const transition = useJobTransition(jobsQueryKey)

  function handleDragStart(event: DragStartEvent) {
    setActiveJobId(String(event.active.id))
  }

  function handleDragEnd(event: DragEndEvent) {
    setActiveJobId(null)
    const { active, over } = event
    if (!over) return
    const jobId = String(active.id)
    const toStateCode = String(over.id)
    const job = jobs.find((j) => j.id === jobId)
    if (!job || job.state_code === toStateCode) return
    transition.mutate({ jobId, toStateCode })
  }

  const activeJob = activeJobId ? jobs.find((j) => j.id === activeJobId) : undefined

  return (
    <div className="flex h-full flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        {branches.data && branches.data.length > 0 && (
          <Select
            value={branchId}
            onChange={(e) => setBranchId(e.target.value)}
            className="w-40"
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
        {technicians.data && user?.role !== 'TECHNICIAN' && (
          <Select
            value={engineerId}
            onChange={(e) => setEngineerId(e.target.value)}
            className="w-48"
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
          onChange={(e) => setWarrantyStatus(e.target.value)}
          className="w-36"
          aria-label="Filter by warranty status"
        >
          <option value="">All warranty</option>
          {WARRANTY_STATUSES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </Select>
        <div className="relative w-56">
          <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Search job#, phone, IMEI…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-7"
          />
        </div>
        <div className="flex-1" />
        {can('job.create') && (
          <Button asChild size="sm">
            <Link to="/jobs/new">
              <Plus /> New job
            </Link>
          </Button>
        )}
      </div>

      {(graph.isPending || jobsQuery.isPending) && (
        <p className="text-sm text-muted-foreground">Loading board…</p>
      )}
      {graph.isError && (
        <p className="text-sm text-destructive">{apiErrorMessage(graph.error)}</p>
      )}
      {jobsQuery.isError && (
        <p className="text-sm text-destructive">{apiErrorMessage(jobsQuery.error)}</p>
      )}

      {graph.data && jobsQuery.data && (
        <DndContext
          sensors={sensors}
          onDragStart={handleDragStart}
          onDragEnd={handleDragEnd}
          onDragCancel={() => setActiveJobId(null)}
        >
          <div className="flex flex-1 gap-3 overflow-x-auto pb-2">
            {graph.data.states
              .filter((s) => s.active)
              .map((state) => (
                <Column
                  key={state.code}
                  code={state.code}
                  label={state.label}
                  isTerminal={state.is_terminal}
                  jobs={jobs.filter((j) => j.state_code === state.code)}
                  customers={customers}
                  devices={devices}
                  engineers={engineers}
                />
              ))}
          </div>
          <DragOverlay>
            {activeJob && (
              <JobCard
                job={activeJob}
                customer={customers.get(activeJob.customer_id)}
                device={devices.get(activeJob.device_id)}
                engineer={
                  activeJob.assigned_engineer_id
                    ? engineers.get(activeJob.assigned_engineer_id)
                    : undefined
                }
              />
            )}
          </DragOverlay>
        </DndContext>
      )}
    </div>
  )
}
