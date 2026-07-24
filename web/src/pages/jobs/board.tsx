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
import {
  Ban,
  CheckCircle2,
  CircleDot,
  ClipboardCheck,
  Inbox,
  PackageCheck,
  AlertTriangle,
  PackageSearch,
  Pin,
  Plus,
  RotateCcw,
  Search,
  Stethoscope,
  Truck,
  UserCheck,
  Wrench,
  type LucideIcon,
} from 'lucide-react'
import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import type { PaginatedResponse } from '@triserve/shared'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
import { api, apiErrorMessage } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { cn } from '@/lib/utils'
import { useByIds } from '@/lib/use-by-ids'
import { useDebouncedValue } from '@/lib/use-debounced-value'
import {
  ConfirmTransitionDialog,
  type PendingMove,
} from '@/pages/jobs/confirm-transition-dialog'
import { useJobTransition } from '@/pages/jobs/use-job-transition'
import { formatAge } from '@/lib/format'
import type {
  BranchWire,
  CustomerWire,
  DeviceWire,
  JobPriority,
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

/** Per-stage identity: an icon + a colour palette. Keyed by the default
 * lifecycle codes; unknown/custom states fall back to a rotating palette
 * (by column position) and a neutral dot icon, so a reconfigured workflow
 * still renders sensibly. */
const STATE_ICON: Record<string, LucideIcon> = {
  RECEIVED: Inbox,
  DIAGNOSING: Stethoscope,
  AWAITING_CUSTOMER_APPROVAL: UserCheck,
  AWAITING_PARTS: PackageSearch,
  IN_REPAIR: Wrench,
  READY_FOR_COLLECTION: PackageCheck,
  QC: ClipboardCheck,
  COMPLETED: CheckCircle2,
  DELIVERED: Truck,
  RETURNED_UNREPAIRED: RotateCcw,
  CANCELLED: Ban,
}

interface Palette {
  chip: string
  topBar: string
  ring: string
}

const PALETTES: Palette[] = [
  { chip: 'bg-blue-500/15 text-blue-600 dark:text-blue-400', topBar: 'border-t-blue-500', ring: 'ring-blue-500/50' },
  { chip: 'bg-amber-500/15 text-amber-600 dark:text-amber-400', topBar: 'border-t-amber-500', ring: 'ring-amber-500/50' },
  { chip: 'bg-violet-500/15 text-violet-600 dark:text-violet-400', topBar: 'border-t-violet-500', ring: 'ring-violet-500/50' },
  { chip: 'bg-orange-500/15 text-orange-600 dark:text-orange-400', topBar: 'border-t-orange-500', ring: 'ring-orange-500/50' },
  { chip: 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400', topBar: 'border-t-emerald-500', ring: 'ring-emerald-500/50' },
  { chip: 'bg-teal-500/15 text-teal-600 dark:text-teal-400', topBar: 'border-t-teal-500', ring: 'ring-teal-500/50' },
  { chip: 'bg-sky-500/15 text-sky-600 dark:text-sky-400', topBar: 'border-t-sky-500', ring: 'ring-sky-500/50' },
  { chip: 'bg-fuchsia-500/15 text-fuchsia-600 dark:text-fuchsia-400', topBar: 'border-t-fuchsia-500', ring: 'ring-fuchsia-500/50' },
]

const TERMINAL_PALETTE: Palette = {
  chip: 'bg-slate-500/15 text-slate-600 dark:text-slate-300',
  topBar: 'border-t-slate-400',
  ring: 'ring-slate-400/50',
}

interface CardProps {
  job: JobWire
  customer?: CustomerWire
  device?: DeviceWire
  engineer?: UserWire
  dragging?: boolean
}

/**
 * Priority shows only when it is NOT normal — see the same note on the list.
 * A chip on every card is 600 identical chips, and the eye stops seeing them.
 */
function priorityChip(priority: JobPriority) {
  if (priority === 'NORMAL') return null
  const tone =
    priority === 'URGENT'
      ? 'border-destructive/40 bg-destructive/10 text-destructive'
      : priority === 'HIGH'
        ? 'border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400'
        : 'border-muted-foreground/30 text-muted-foreground'
  return (
    <span
      className={`rounded-full border px-1.5 py-0.5 text-[10px] font-semibold uppercase ${tone}`}
    >
      {priority}
    </span>
  )
}

function JobCard({ job, customer, device, engineer, dragging }: CardProps) {
  return (
    <div
      className={
        'flex flex-col gap-1.5 rounded-lg border bg-card p-3 text-sm shadow-xs' +
        // A left edge rather than a background wash: it reads at a glance down
        // a dense column without fighting the card's own content.
        (job.is_overdue ? ' border-l-2 border-l-destructive' : '') +
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
        <span className="flex shrink-0 items-center gap-1">
          {priorityChip(job.priority)}
          {warrantyBadge(job.warranty_status)}
        </span>
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
          <span
            className={job.is_overdue ? 'font-medium text-destructive' : ''}
            title={
              job.sla_due_at
                ? `Target ${new Date(job.sla_due_at).toLocaleDateString()}${job.is_overdue ? ' — overdue' : ''}`
                : 'No turnaround target'
            }
          >
            {job.is_overdue && (
              <AlertTriangle className="mr-0.5 inline size-3 align-[-1px]" />
            )}
            {formatAge(job.received_at)}
          </span>
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
  icon: Icon,
  palette,
  isTerminal,
  pinned,
  jobs,
  customers,
  devices,
  engineers,
}: {
  code: string
  label: string
  icon: LucideIcon
  palette: Palette
  isTerminal: boolean
  pinned: boolean
  jobs: JobWire[]
  customers: Map<string, CustomerWire>
  devices: Map<string, DeviceWire>
  engineers: Map<string, UserWire>
}) {
  const { setNodeRef, isOver } = useDroppable({ id: code })

  // Empty, non-pinned columns collapse to a slim rail so the populated stages
  // get the space — but they expand while a card is dragged over them so they
  // stay an easy drop target.
  const collapsed = jobs.length === 0 && !pinned && !isOver

  if (collapsed) {
    return (
      <div
        ref={setNodeRef}
        className="flex w-12 shrink-0 flex-col items-center gap-2 rounded-xl border border-dashed bg-muted/20 py-3"
        title={`${label} — no jobs`}
      >
        <span className={cn('flex size-8 items-center justify-center rounded-lg', palette.chip)}>
          <Icon className="size-4" />
        </span>
        <span className="rotate-180 text-xs font-medium text-muted-foreground [writing-mode:vertical-rl]">
          {label}
        </span>
        <span className="rounded-full bg-muted px-1.5 text-[10px] font-semibold text-muted-foreground">
          0
        </span>
      </div>
    )
  }

  return (
    <div
      ref={setNodeRef}
      className={cn(
        'flex w-72 shrink-0 flex-col gap-2 rounded-xl border border-t-[3px] bg-muted/30 p-2 transition-shadow',
        palette.topBar,
        isOver && cn('ring-2', palette.ring),
        pinned && 'sticky left-0 z-20 bg-card shadow-[6px_0_16px_-8px_rgba(0,0,0,0.35)]',
        isTerminal && 'opacity-95',
      )}
    >
      <div className="flex items-center justify-between gap-2 px-1 pt-1">
        <span className="flex min-w-0 items-center gap-2">
          <span className={cn('flex size-7 shrink-0 items-center justify-center rounded-lg', palette.chip)}>
            <Icon className="size-4" />
          </span>
          <span className="truncate text-sm font-semibold">{label}</span>
          {pinned && <Pin className="size-3 shrink-0 fill-current text-muted-foreground" />}
        </span>
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
          <p className="rounded-lg border border-dashed px-2 py-6 text-center text-xs text-muted-foreground">
            Drop a job here
          </p>
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
  const [pendingMove, setPendingMove] = useState<PendingMove | null>(null)

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
    // Confirm before applying — a stray drop must not silently advance a job
    // that usually can't be moved back.
    setPendingMove({
      jobId,
      toStateCode,
      fromLabel: job.state_label,
      toLabel:
        graph.data?.states.find((s) => s.code === toStateCode)?.label ??
        toStateCode,
    })
  }

  const activeJob = activeJobId ? jobs.find((j) => j.id === activeJobId) : undefined

  // Columns in lifecycle order, each decorated with an icon + a distinct
  // palette. The initial state is pinned to the left; terminal states share a
  // neutral palette and don't consume a colour slot.
  const orderedStates = useMemo(() => {
    const states = (graph.data?.states ?? [])
      .filter((s) => s.active)
      .sort((a, b) => a.sort_order - b.sort_order)
    const pinnedCode = states.find((s) => s.is_initial)?.code ?? states[0]?.code
    let idx = 0
    return states.map((s) => ({
      ...s,
      icon: STATE_ICON[s.code] ?? CircleDot,
      palette: s.is_terminal ? TERMINAL_PALETTE : PALETTES[idx++ % PALETTES.length],
      pinned: s.code === pinnedCode,
    }))
  }, [graph.data])

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
            {orderedStates.map((state) => (
              <Column
                key={state.code}
                code={state.code}
                label={state.label}
                icon={state.icon}
                palette={state.palette}
                isTerminal={state.is_terminal}
                pinned={state.pinned}
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

      <ConfirmTransitionDialog
        move={pendingMove}
        isPending={transition.isPending}
        onOpenChange={(open) => {
          if (!open) setPendingMove(null)
        }}
        onConfirm={(note) => {
          if (!pendingMove) return
          transition.mutate(
            {
              jobId: pendingMove.jobId,
              toStateCode: pendingMove.toStateCode,
              note: note || undefined,
            },
            { onSuccess: () => setPendingMove(null) },
          )
        }}
      />
    </div>
  )
}
