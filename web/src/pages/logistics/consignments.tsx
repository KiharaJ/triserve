import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { toast } from 'sonner'
import type { PaginatedResponse } from '@triserve/shared'
import { FormField } from '@/components/shared/form-field'
import { Pager } from '@/components/shared/pager'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { Textarea } from '@/components/ui/textarea'
import { api, apiErrorMessage } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { formatDateTime } from '@/lib/format'
import type {
  BranchWire,
  Consignment,
  ConsignmentDirection,
  ConsignmentStatus,
  ScanPoint,
} from '@/lib/types'

const STATUSES: ConsignmentStatus[] = [
  'OPEN',
  'IN_TRANSIT',
  'ARRIVED',
  'CANCELLED',
]

const DIRECTIONS: { value: ConsignmentDirection; label: string }[] = [
  { value: 'INBOUND_TO_HUB', label: 'Spoke → hub' },
  { value: 'OUTBOUND_TO_SPOKE', label: 'Hub → spoke' },
]

const SCAN_POINTS: { value: ScanPoint; label: string }[] = [
  { value: 'HUB_DEPART', label: 'Left the hub' },
  { value: 'COURIER_HUB', label: 'At the courier hub' },
  { value: 'COURIER_DEPART', label: 'Left the courier' },
  { value: 'SPOKE_ARRIVE', label: 'Arrived at the spoke' },
  { value: 'HUB_ARRIVE', label: 'Arrived at the hub' },
  { value: 'CUSTOM', label: 'Other' },
]

function statusBadge(status: ConsignmentStatus) {
  switch (status) {
    case 'OPEN':
      return <Badge variant="warning">Open</Badge>
    case 'IN_TRANSIT':
      return <Badge variant="default">In transit</Badge>
    case 'ARRIVED':
      return <Badge variant="success">Arrived</Badge>
    default:
      return <Badge variant="secondary">Cancelled</Badge>
  }
}

/**
 * Consignments (SCMS proposal Module 6, §7 steps 2–3) — the sealed tote that
 * carries devices between a spoke branch and the hub, with a chain-of-custody
 * scan trail and a manifest that is checked in on arrival.
 *
 * The manifest is the point of the whole screen: anything packed but not
 * checked in at the far end is reported as MISSING rather than quietly
 * disappearing, which is how a lost handset gets noticed the same day.
 */
export function ConsignmentsPage() {
  const { can } = useAuth()
  const queryClient = useQueryClient()
  const [page, setPage] = useState(1)
  const [statusFilter, setStatusFilter] = useState('')
  const [directionFilter, setDirectionFilter] = useState('')
  const [openId, setOpenId] = useState<string | null>(null)
  const [createOpen, setCreateOpen] = useState(false)

  const canManage = can('consignment.manage')
  const canScan = can('consignment.scan')

  const branches = useQuery({
    queryKey: ['branches', 'all'],
    queryFn: async () =>
      (
        await api.get<PaginatedResponse<BranchWire>>('/branches', {
          params: { page_size: 100 },
        })
      ).data.data,
  })

  const list = useQuery({
    queryKey: ['consignments', page, statusFilter, directionFilter],
    queryFn: async () =>
      (
        await api.get<PaginatedResponse<Consignment>>('/consignments', {
          params: {
            page,
            page_size: 20,
            ...(statusFilter ? { status: statusFilter } : {}),
            ...(directionFilter ? { direction: directionFilter } : {}),
          },
        })
      ).data,
  })

  const refresh = () =>
    queryClient.invalidateQueries({ queryKey: ['consignments'] })

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <Select
          value={statusFilter}
          onChange={(e) => {
            setStatusFilter(e.target.value)
            setPage(1)
          }}
          className="w-40"
          aria-label="Filter by status"
        >
          <option value="">All statuses</option>
          {STATUSES.map((s) => (
            <option key={s} value={s}>
              {s.replace('_', ' ')}
            </option>
          ))}
        </Select>
        <Select
          value={directionFilter}
          onChange={(e) => {
            setDirectionFilter(e.target.value)
            setPage(1)
          }}
          className="w-44"
          aria-label="Filter by direction"
        >
          <option value="">Both directions</option>
          {DIRECTIONS.map((d) => (
            <option key={d.value} value={d.value}>
              {d.label}
            </option>
          ))}
        </Select>
        <div className="flex-1" />
        {canManage && (
          <Button onClick={() => setCreateOpen(true)}>New consignment</Button>
        )}
      </div>

      {list.isPending && (
        <p className="text-sm text-muted-foreground">Loading…</p>
      )}
      {list.isError && (
        <p className="text-sm text-destructive">{apiErrorMessage(list.error)}</p>
      )}

      {list.data && (
        <div className="overflow-hidden rounded-xl border bg-card shadow-sm">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Consignment</TableHead>
                <TableHead>Tote</TableHead>
                <TableHead>Route</TableHead>
                <TableHead className="text-right">Devices</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Dispatched</TableHead>
                <TableHead className="w-20" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {list.data.data.length === 0 && (
                <TableRow>
                  <TableCell
                    colSpan={7}
                    className="text-center text-muted-foreground"
                  >
                    No consignments
                  </TableCell>
                </TableRow>
              )}
              {list.data.data.map((c) => (
                <TableRow key={c.id}>
                  <TableCell className="font-medium">
                    {c.consignment_no}
                  </TableCell>
                  <TableCell className="font-mono text-sm">
                    {c.tote_label}
                  </TableCell>
                  <TableCell className="text-sm">
                    {c.from_branch} → {c.to_branch}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {c.job_count}
                    {c.missing_count > 0 && (
                      <Badge variant="destructive" className="ml-2">
                        {c.missing_count} missing
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell>{statusBadge(c.status)}</TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {c.dispatched_at ? formatDateTime(c.dispatched_at) : '—'}
                  </TableCell>
                  <TableCell>
                    <Button
                      variant="ghost"
                      size="xs"
                      onClick={() => setOpenId(c.id)}
                    >
                      Open
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <Pager
            page={page}
            pageSize={20}
            total={list.data.total}
            onPageChange={setPage}
          />
        </div>
      )}

      {createOpen && (
        <CreateDialog
          branches={branches.data ?? []}
          onClose={() => setCreateOpen(false)}
          onCreated={async (id) => {
            setCreateOpen(false)
            await refresh()
            setOpenId(id)
          }}
        />
      )}

      {openId && (
        <DetailDialog
          id={openId}
          canManage={canManage}
          canScan={canScan}
          onClose={() => setOpenId(null)}
          onChanged={refresh}
        />
      )}
    </div>
  )
}

function CreateDialog({
  branches,
  onClose,
  onCreated,
}: {
  branches: BranchWire[]
  onClose: () => void
  onCreated: (id: string) => void | Promise<void>
}) {
  const [fromBranch, setFromBranch] = useState('')
  const [toBranch, setToBranch] = useState('')
  const [direction, setDirection] =
    useState<ConsignmentDirection>('INBOUND_TO_HUB')
  const [toteLabel, setToteLabel] = useState('')
  const [courier, setCourier] = useState('')
  const [notes, setNotes] = useState('')

  const create = useMutation({
    mutationFn: async () =>
      (
        await api.post<Consignment>('/consignments', {
          from_branch_id: fromBranch,
          to_branch_id: toBranch,
          direction,
          ...(toteLabel.trim() ? { tote_label: toteLabel.trim() } : {}),
          ...(courier.trim() ? { courier_name: courier.trim() } : {}),
          ...(notes.trim() ? { notes: notes.trim() } : {}),
        })
      ).data,
    onSuccess: async (c) => {
      toast.success(`Consignment ${c.consignment_no} opened`)
      await onCreated(c.id)
    },
    onError: (e) => toast.error(apiErrorMessage(e)),
  })

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New consignment</DialogTitle>
          <DialogDescription>
            Opens an empty tote. Pack jobs into it while it stays open, then
            seal and dispatch.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <FormField label="From branch">
            <Select
              value={fromBranch}
              onChange={(e) => setFromBranch(e.target.value)}
            >
              <option value="">Select…</option>
              {branches.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.code} — {b.name}
                </option>
              ))}
            </Select>
          </FormField>
          <FormField label="To branch">
            <Select
              value={toBranch}
              onChange={(e) => setToBranch(e.target.value)}
            >
              <option value="">Select…</option>
              {branches.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.code} — {b.name}
                </option>
              ))}
            </Select>
          </FormField>
          <FormField label="Direction">
            <Select
              value={direction}
              onChange={(e) =>
                setDirection(e.target.value as ConsignmentDirection)
              }
            >
              {DIRECTIONS.map((d) => (
                <option key={d.value} value={d.value}>
                  {d.label}
                </option>
              ))}
            </Select>
          </FormField>
          <FormField
            label="Tote label"
            hint="The barcode on the physical tote. Leave blank and one is minted."
          >
            <Input
              value={toteLabel}
              onChange={(e) => setToteLabel(e.target.value)}
              placeholder="Optional"
            />
          </FormField>
          <FormField label="Courier">
            <Input
              value={courier}
              onChange={(e) => setCourier(e.target.value)}
              placeholder="Optional"
            />
          </FormField>
          <FormField label="Notes">
            <Textarea
              rows={2}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
            />
          </FormField>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={!fromBranch || !toBranch || create.isPending}
            onClick={() => create.mutate()}
          >
            Open consignment
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function DetailDialog({
  id,
  canManage,
  canScan,
  onClose,
  onChanged,
}: {
  id: string
  canManage: boolean
  canScan: boolean
  onClose: () => void
  onChanged: () => void | Promise<void>
}) {
  const queryClient = useQueryClient()
  const [jobIds, setJobIds] = useState('')
  const [scanPoint, setScanPoint] = useState<ScanPoint>('HUB_DEPART')
  const [scanLocation, setScanLocation] = useState('')
  const [present, setPresent] = useState<Set<string>>(new Set())

  const detailKey = ['consignment', id]
  const detail = useQuery({
    queryKey: detailKey,
    queryFn: async () => (await api.get<Consignment>(`/consignments/${id}`)).data,
  })

  const after = async () => {
    await queryClient.invalidateQueries({ queryKey: detailKey })
    await onChanged()
  }

  const addJobs = useMutation({
    mutationFn: async () =>
      api.post(`/consignments/${id}/jobs`, {
        job_ids: jobIds
          .split(/[\s,]+/)
          .map((s) => s.trim())
          .filter(Boolean),
      }),
    onSuccess: async () => {
      toast.success('Packed')
      setJobIds('')
      await after()
    },
    onError: (e) => toast.error(apiErrorMessage(e)),
  })

  const dispatchIt = useMutation({
    mutationFn: async () => api.post(`/consignments/${id}/dispatch`, {}),
    onSuccess: async () => {
      toast.success('Sealed and dispatched')
      await after()
    },
    onError: (e) => toast.error(apiErrorMessage(e)),
  })

  const scan = useMutation({
    mutationFn: async () =>
      api.post(`/consignments/${id}/scan`, {
        scan_point: scanPoint,
        ...(scanLocation.trim() ? { location: scanLocation.trim() } : {}),
      }),
    onSuccess: async () => {
      toast.success('Scan recorded')
      setScanLocation('')
      await after()
    },
    onError: (e) => toast.error(apiErrorMessage(e)),
  })

  const arrive = useMutation({
    mutationFn: async () =>
      api.post(`/consignments/${id}/arrive`, { job_ids: [...present] }),
    onSuccess: async () => {
      toast.success('Checked in')
      await after()
    },
    onError: (e) => toast.error(apiErrorMessage(e)),
  })

  const c = detail.data

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>
            {c ? `${c.consignment_no} · tote ${c.tote_label}` : 'Consignment'}
          </DialogTitle>
          {c && (
            <DialogDescription>
              {c.from_branch} → {c.to_branch} · {c.job_count} device(s)
            </DialogDescription>
          )}
        </DialogHeader>

        {detail.isPending && (
          <p className="text-sm text-muted-foreground">Loading…</p>
        )}
        {detail.isError && (
          <p className="text-sm text-destructive">
            {apiErrorMessage(detail.error)}
          </p>
        )}

        {c && (
          <div className="max-h-[60vh] space-y-5 overflow-y-auto pr-1">
            <div className="flex flex-wrap items-center gap-2">
              {statusBadge(c.status)}
              {c.missing_count > 0 && (
                <Badge variant="destructive">
                  {c.missing_count} not checked in
                </Badge>
              )}
            </div>

            <section>
              <h3 className="mb-2 text-sm font-medium">Manifest</h3>
              <div className="overflow-hidden rounded-lg border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      {c.status === 'IN_TRANSIT' && canManage && (
                        <TableHead className="w-10">In</TableHead>
                      )}
                      <TableHead>Job</TableHead>
                      <TableHead>Customer</TableHead>
                      <TableHead>Device</TableHead>
                      <TableHead>Checked in</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {c.jobs.length === 0 && (
                      <TableRow>
                        <TableCell
                          colSpan={5}
                          className="text-center text-muted-foreground"
                        >
                          Nothing packed yet
                        </TableCell>
                      </TableRow>
                    )}
                    {c.jobs.map((j) => (
                      <TableRow key={j.job_id}>
                        {c.status === 'IN_TRANSIT' && canManage && (
                          <TableCell>
                            <input
                              type="checkbox"
                              aria-label={`${j.job_no} present`}
                              checked={present.has(j.job_id)}
                              onChange={(e) => {
                                const next = new Set(present)
                                if (e.target.checked) next.add(j.job_id)
                                else next.delete(j.job_id)
                                setPresent(next)
                              }}
                            />
                          </TableCell>
                        )}
                        <TableCell className="font-medium">{j.job_no}</TableCell>
                        <TableCell className="text-sm">
                          {j.customer_name}
                        </TableCell>
                        <TableCell className="text-sm">
                          {j.device}
                          {j.imei_serial && (
                            <span className="ml-1 font-mono text-xs text-muted-foreground">
                              {j.imei_serial}
                            </span>
                          )}
                        </TableCell>
                        <TableCell className="text-sm">
                          {j.checked_in_at ? (
                            formatDateTime(j.checked_in_at)
                          ) : j.missing ? (
                            <Badge variant="destructive">Missing</Badge>
                          ) : (
                            '—'
                          )}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </section>

            {c.status === 'OPEN' && canManage && (
              <section className="space-y-2 rounded-lg border border-dashed p-3">
                <h3 className="text-sm font-medium">Pack more jobs</h3>
                <Textarea
                  rows={2}
                  placeholder="Paste job IDs, separated by spaces or commas"
                  value={jobIds}
                  onChange={(e) => setJobIds(e.target.value)}
                />
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={!jobIds.trim() || addJobs.isPending}
                    onClick={() => addJobs.mutate()}
                  >
                    Add to tote
                  </Button>
                  <Button
                    size="sm"
                    disabled={c.job_count === 0 || dispatchIt.isPending}
                    onClick={() => dispatchIt.mutate()}
                  >
                    Seal &amp; dispatch
                  </Button>
                </div>
              </section>
            )}

            <section>
              <h3 className="mb-2 text-sm font-medium">Chain of custody</h3>
              {c.scans.length === 0 ? (
                <p className="text-sm text-muted-foreground">No scans yet.</p>
              ) : (
                <ol className="space-y-1 text-sm">
                  {c.scans.map((s) => (
                    <li key={s.id} className="flex flex-wrap gap-2">
                      <span className="font-medium">
                        {SCAN_POINTS.find((p) => p.value === s.scan_point)
                          ?.label ?? s.scan_point}
                      </span>
                      <span className="text-muted-foreground">
                        {formatDateTime(s.scanned_at)}
                        {s.location && ` · ${s.location}`}
                        {s.handler_name && ` · ${s.handler_name}`}
                      </span>
                    </li>
                  ))}
                </ol>
              )}
              {c.status === 'IN_TRANSIT' && canScan && (
                <div className="mt-2 flex flex-wrap gap-2">
                  <Select
                    value={scanPoint}
                    onChange={(e) => setScanPoint(e.target.value as ScanPoint)}
                    className="w-48"
                    aria-label="Scan point"
                  >
                    {SCAN_POINTS.map((p) => (
                      <option key={p.value} value={p.value}>
                        {p.label}
                      </option>
                    ))}
                  </Select>
                  <Input
                    className="max-w-48"
                    placeholder="Location (optional)"
                    value={scanLocation}
                    onChange={(e) => setScanLocation(e.target.value)}
                  />
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={scan.isPending}
                    onClick={() => scan.mutate()}
                  >
                    Record scan
                  </Button>
                </div>
              )}
            </section>

            {c.status === 'IN_TRANSIT' && canManage && (
              <section className="space-y-2 rounded-lg border border-dashed p-3">
                <h3 className="text-sm font-medium">Check the tote in</h3>
                <p className="text-xs text-muted-foreground">
                  Tick every device physically in the tote. Anything left
                  unticked is recorded as missing — that is what the manifest is
                  for.
                </p>
                <Button
                  size="sm"
                  disabled={arrive.isPending}
                  onClick={() => arrive.mutate()}
                >
                  Mark arrived ({present.size}/{c.job_count} present)
                </Button>
              </section>
            )}
          </div>
        )}

        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
