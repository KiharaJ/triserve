import { zodResolver } from '@hookform/resolvers/zod'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ShieldCheck } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useForm } from 'react-hook-form'
import { Link, useParams } from 'react-router-dom'
import { toast } from 'sonner'
import { z } from 'zod'
import type { PaginatedResponse } from '@triserve/shared'
import { FormField } from '@/components/shared/form-field'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Textarea } from '@/components/ui/textarea'
import { api, apiErrorMessage } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { formatDate, formatDateTime, formatMoney } from '@/lib/format'
import type {
  AttachmentWire,
  AuditLogEntry,
  BranchWire,
  JobDetailWire,
  JobPartWire,
  PartWire,
  UserWire,
  WarrantyRegistrationWire,
  WarrantyStatus,
} from '@/lib/types'
import { useJobTransition } from '@/pages/jobs/use-job-transition'

const WARRANTY_STATUSES: WarrantyStatus[] = ['IW', 'OW', 'GOODWILL', 'UNKNOWN']
const WARRANTY_KIND_LABEL: Record<string, string> = {
  STORE: 'store',
  MANUFACTURER: 'manufacturer',
  SAMSUNG: 'Samsung',
}

const detailsSchema = z.object({
  branch_id: z.string().optional(),
  fault_reported: z.string().max(5000).optional(),
  assigned_engineer_id: z.string().optional(),
  warranty_status: z.enum(['IW', 'OW', 'GOODWILL', 'UNKNOWN']),
  so_number: z.string().max(100).optional(),
  notes: z.string().max(5000).optional(),
})
type DetailsValues = z.infer<typeof detailsSchema>

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

function DetailsTab({ job }: { job: JobDetailWire }) {
  const { can, user } = useAuth()
  const queryClient = useQueryClient()
  const isGroup = user?.scope === 'group'

  const form = useForm<DetailsValues>({
    resolver: zodResolver(detailsSchema),
    defaultValues: {
      branch_id: job.branch_id,
      fault_reported: job.fault_reported ?? '',
      assigned_engineer_id: job.assigned_engineer_id ?? '',
      warranty_status: job.warranty_status,
      so_number: job.so_number ?? '',
      notes: job.notes ?? '',
    },
  })

  // The engineer picker is SCOPED to the (possibly pending) branch — assigning
  // an out-of-branch engineer makes the job invisible to them (jobs are
  // branch-scoped). A group admin editing the branch follows the new selection.
  const selectedBranch = form.watch('branch_id') || job.branch_id

  const engineers = useQuery({
    queryKey: ['users', 'technicians', selectedBranch],
    enabled: can('user.read'),
    queryFn: async () =>
      (
        await api.get<PaginatedResponse<UserWire>>('/users', {
          params: {
            role: 'TECHNICIAN',
            active: true,
            branch_id: selectedBranch,
            page_size: 100,
          },
        })
      ).data.data,
  })

  // Group users can MOVE a mis-booked job to another branch.
  const branches = useQuery({
    queryKey: ['branches', 'all'],
    enabled: isGroup && can('config.read'),
    queryFn: async () =>
      (
        await api.get<PaginatedResponse<BranchWire>>('/branches', {
          params: { page_size: 100 },
        })
      ).data.data,
  })

  useEffect(() => {
    form.reset({
      branch_id: job.branch_id,
      fault_reported: job.fault_reported ?? '',
      assigned_engineer_id: job.assigned_engineer_id ?? '',
      warranty_status: job.warranty_status,
      so_number: job.so_number ?? '',
      notes: job.notes ?? '',
    })
    // Reset only when a DIFFERENT job loads — not on every keystroke/refetch,
    // which would otherwise clobber in-progress edits.
  }, [job.id])

  const save = useMutation({
    mutationFn: async (values: DetailsValues) =>
      (
        await api.patch<JobDetailWire>(`/jobs/${job.id}`, {
          branch_id:
            isGroup && values.branch_id && values.branch_id !== job.branch_id
              ? values.branch_id
              : undefined,
          fault_reported: values.fault_reported || undefined,
          assigned_engineer_id: values.assigned_engineer_id || null,
          warranty_status: values.warranty_status,
          so_number: values.so_number || undefined,
          notes: values.notes || undefined,
        })
      ).data,
    onSuccess: async () => {
      toast.success('Job updated')
      await queryClient.invalidateQueries({ queryKey: ['job', job.id] })
    },
    onError: (e) => toast.error(apiErrorMessage(e)),
  })

  const canEdit = can('job.update')

  return (
    <form
      onSubmit={(e) => void form.handleSubmit((v) => save.mutate(v))(e)}
      className="flex max-w-xl flex-col gap-3"
    >
      <FormField label="Fault reported" htmlFor="d-fault_reported">
        <Textarea id="d-fault_reported" rows={3} disabled={!canEdit} {...form.register('fault_reported')} />
      </FormField>
      {isGroup && branches.data && (
        <FormField
          label="Branch"
          htmlFor="d-branch"
          hint="Move a mis-booked job to another branch. Reassign the engineer afterwards."
        >
          <Select
            id="d-branch"
            disabled={!canEdit}
            {...form.register('branch_id')}
            onChange={(e) => {
              // A new branch invalidates the current engineer (out of branch),
              // so clear it — the admin picks one from the new branch's list.
              form.setValue('branch_id', e.target.value)
              form.setValue('assigned_engineer_id', '')
            }}
          >
            {branches.data.map((b) => (
              <option key={b.id} value={b.id}>
                {b.code} — {b.name}
              </option>
            ))}
          </Select>
        </FormField>
      )}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <FormField label="Warranty status" htmlFor="d-warranty_status">
          <Select id="d-warranty_status" disabled={!canEdit} {...form.register('warranty_status')}>
            {WARRANTY_STATUSES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </Select>
        </FormField>
        {can('user.read') ? (
          <FormField label="Assigned engineer" htmlFor="d-engineer">
            <Select id="d-engineer" disabled={!canEdit} {...form.register('assigned_engineer_id')}>
              <option value="">Unassigned</option>
              {engineers.data?.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.full_name}
                </option>
              ))}
            </Select>
          </FormField>
        ) : (
          <FormField label="Assigned engineer" htmlFor="d-engineer-name">
            {/* Technicians can't list users, so show the resolved name off the
                job itself rather than the raw id. */}
            <Input
              id="d-engineer-name"
              disabled
              value={job.assigned_engineer_name ?? 'Unassigned'}
              readOnly
            />
          </FormField>
        )}
      </div>
      <FormField label="Samsung SO number" htmlFor="d-so_number">
        <Input id="d-so_number" disabled={!canEdit} {...form.register('so_number')} />
      </FormField>
      <FormField label="Notes" htmlFor="d-notes">
        <Textarea id="d-notes" rows={3} disabled={!canEdit} {...form.register('notes')} />
      </FormField>
      {canEdit && (
        <div>
          <Button type="submit" disabled={save.isPending}>
            {save.isPending ? 'Saving…' : 'Save changes'}
          </Button>
        </div>
      )}
    </form>
  )
}

function TechReportTab({ job }: { job: JobDetailWire }) {
  const { can } = useAuth()
  const queryClient = useQueryClient()
  const [techReport, setTechReport] = useState(job.tech_report ?? '')

  useEffect(() => setTechReport(job.tech_report ?? ''), [job.id, job.tech_report])

  const save = useMutation({
    mutationFn: async () =>
      (await api.patch<JobDetailWire>(`/jobs/${job.id}`, { tech_report: techReport })).data,
    onSuccess: async () => {
      toast.success('Tech report saved')
      await queryClient.invalidateQueries({ queryKey: ['job', job.id] })
    },
    onError: (e) => toast.error(apiErrorMessage(e)),
  })

  const canEdit = can('job.update')

  return (
    <div className="flex max-w-xl flex-col gap-3">
      <FormField label="Tech report" htmlFor="tech-report">
        <Textarea
          id="tech-report"
          rows={8}
          disabled={!canEdit}
          value={techReport}
          onChange={(e) => setTechReport(e.target.value)}
          placeholder="Diagnosis, parts replaced, repair actions…"
        />
      </FormField>
      {canEdit && (
        <div>
          <Button onClick={() => save.mutate()} disabled={save.isPending}>
            {save.isPending ? 'Saving…' : 'Save tech report'}
          </Button>
        </div>
      )}
    </div>
  )
}

function Gallery({ title, items }: { title: string; items: AttachmentWire[] }) {
  if (items.length === 0) return null
  return (
    <div className="flex flex-col gap-2">
      <h4 className="text-sm font-medium">{title}</h4>
      <div className="flex flex-wrap gap-2">
        {items.map((a) => (
          <a key={a.id} href={a.url} target="_blank" rel="noreferrer">
            <img src={a.url} alt={a.file_name} className="size-24 rounded-md border object-cover" />
          </a>
        ))}
      </div>
    </div>
  )
}

function AttachmentsTab({ job }: { job: JobDetailWire }) {
  const { can } = useAuth()
  const queryClient = useQueryClient()

  const attachments = useQuery({
    queryKey: ['attachments', 'JOB', job.id],
    queryFn: async () =>
      (
        await api.get<PaginatedResponse<AttachmentWire>>('/attachments', {
          params: { owner_type: 'JOB', owner_id: job.id },
        })
      ).data.data,
    enabled: can('attachment.read'),
  })

  const upload = useMutation({
    mutationFn: async (files: File[]) => {
      for (const file of files) {
        const fd = new FormData()
        fd.append('file', file)
        fd.append('owner_type', 'JOB')
        fd.append('owner_id', job.id)
        fd.append('kind', 'PHOTO_AFTER')
        await api.post('/attachments', fd)
      }
    },
    onSuccess: async () => {
      toast.success('After-photos uploaded')
      await queryClient.invalidateQueries({ queryKey: ['attachments', 'JOB', job.id] })
    },
    onError: (e) => toast.error(apiErrorMessage(e)),
  })

  if (!can('attachment.read')) {
    return <p className="text-sm text-muted-foreground">You do not have permission to view attachments.</p>
  }

  const rows = attachments.data ?? []
  const before = rows.filter((a) => a.kind === 'PHOTO_BEFORE')
  const after = rows.filter((a) => a.kind === 'PHOTO_AFTER')
  const signature = rows.filter((a) => a.kind === 'SIGNATURE')
  const other = rows.filter((a) => !['PHOTO_BEFORE', 'PHOTO_AFTER', 'SIGNATURE'].includes(a.kind))

  return (
    <div className="flex flex-col gap-4">
      {attachments.isPending && <p className="text-sm text-muted-foreground">Loading…</p>}
      <Gallery title="Before" items={before} />
      <Gallery title="After" items={after} />
      <Gallery title="Signature" items={signature} />
      <Gallery title="Other" items={other} />
      {rows.length === 0 && !attachments.isPending && (
        <p className="text-sm text-muted-foreground">No attachments yet.</p>
      )}
      {can('attachment.create') && (
        <FormField label="Upload after-photos" htmlFor="after-photos">
          <Input
            id="after-photos"
            type="file"
            accept="image/*"
            multiple
            onChange={(e) => {
              if (e.target.files) upload.mutate(Array.from(e.target.files))
              e.target.value = ''
            }}
          />
        </FormField>
      )}
    </div>
  )
}

function actionBadge(action: AuditLogEntry['action']) {
  switch (action) {
    case 'CREATE':
      return <Badge variant="success">CREATE</Badge>
    case 'TRANSITION':
      return <Badge variant="default">TRANSITION</Badge>
    case 'DELETE':
    case 'REJECT':
      return <Badge variant="destructive">{action}</Badge>
    default:
      return <Badge variant="secondary">{action}</Badge>
  }
}

function HistoryTab({ job }: { job: JobDetailWire }) {
  const entries = useQuery({
    queryKey: ['audit-log', 'Job', job.id],
    queryFn: async () =>
      (
        await api.get<PaginatedResponse<AuditLogEntry>>('/audit-log', {
          params: { entity_type: 'Job', entity_id: job.id, page_size: 100 },
        })
      ).data.data,
  })

  if (entries.isPending) return <p className="text-sm text-muted-foreground">Loading…</p>
  if (entries.isError) return <p className="text-sm text-destructive">{apiErrorMessage(entries.error)}</p>

  return (
    <div className="flex flex-col gap-2">
      {entries.data?.length === 0 && (
        <p className="text-sm text-muted-foreground">No history yet.</p>
      )}
      {entries.data?.map((e) => (
        <div key={e.id} className="flex items-center gap-3 rounded-md border px-3 py-2 text-sm">
          <span className="w-40 shrink-0 text-xs text-muted-foreground">{formatDateTime(e.at)}</span>
          {actionBadge(e.action)}
          <span className="text-muted-foreground">
            {e.action === 'TRANSITION' && e.after_json && typeof e.after_json === 'object'
              ? `${(e.before_json as { state_code?: string } | null)?.state_code ?? '?'} → ${
                  (e.after_json as { state_code?: string }).state_code ?? '?'
                }${(e.after_json as { note?: string }).note ? ` — “${(e.after_json as { note?: string }).note}”` : ''}`
              : null}
          </span>
        </div>
      ))}
    </div>
  )
}

function PartsTab({ job }: { job: JobDetailWire }) {
  const { can } = useAuth()
  const queryClient = useQueryClient()
  const [partId, setPartId] = useState('')
  const [qty, setQty] = useState('1')

  const canReserve = can('inventory.reserve')
  const canConsume = can('inventory.consume')

  const parts = useQuery({
    queryKey: ['job-parts', job.id],
    queryFn: async () =>
      (await api.get<JobPartWire[]>(`/jobs/${job.id}/parts`)).data,
  })

  const catalogue = useQuery({
    queryKey: ['parts', 'options'],
    enabled: canReserve,
    queryFn: async () =>
      (
        await api.get<PaginatedResponse<PartWire>>('/parts', {
          params: { page_size: 100, active: true },
        })
      ).data.data,
  })

  const invalidate = async () => {
    await queryClient.invalidateQueries({ queryKey: ['job-parts', job.id] })
    await queryClient.invalidateQueries({ queryKey: ['inventory'] })
  }

  const add = useMutation({
    mutationFn: async () =>
      (
        await api.post<JobPartWire>(`/jobs/${job.id}/parts`, {
          part_id: partId,
          qty: Number(qty),
        })
      ).data,
    onSuccess: async () => {
      toast.success('Part reserved')
      setPartId('')
      setQty('1')
      await invalidate()
    },
    onError: (e) => toast.error(apiErrorMessage(e)),
  })

  const remove = useMutation({
    mutationFn: async (lineId: string) =>
      api.delete(`/jobs/${job.id}/parts/${lineId}`),
    onSuccess: async () => {
      toast.success('Reservation released')
      await invalidate()
    },
    onError: (e) => toast.error(apiErrorMessage(e)),
  })

  const consume = useMutation({
    mutationFn: async (lineId: string) =>
      api.post(`/jobs/${job.id}/parts/${lineId}/consume`),
    onSuccess: async () => {
      toast.success('Part consumed')
      await invalidate()
    },
    onError: (e) => toast.error(apiErrorMessage(e)),
  })

  const consumeAll = useMutation({
    mutationFn: async () => api.post(`/jobs/${job.id}/parts/consume`),
    onSuccess: async () => {
      toast.success('All reserved parts consumed')
      await invalidate()
    },
    onError: (e) => toast.error(apiErrorMessage(e)),
  })

  const lines = parts.data ?? []
  const reserved = lines.filter((l) => l.status === 'RESERVED')
  const busy =
    add.isPending ||
    remove.isPending ||
    consume.isPending ||
    consumeAll.isPending

  return (
    <div className="flex flex-col gap-4">
      {parts.isPending && (
        <p className="text-sm text-muted-foreground">Loading…</p>
      )}
      {lines.length > 0 && (
        <div className="overflow-hidden rounded-xl border bg-card shadow-sm">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Part</TableHead>
                <TableHead className="text-right">Qty</TableHead>
                <TableHead className="text-right">Unit price</TableHead>
                <TableHead>Warranty</TableHead>
                <TableHead>Status</TableHead>
                {(canReserve || canConsume) && <TableHead className="w-40" />}
              </TableRow>
            </TableHeader>
            <TableBody>
              {lines.map((l) => (
                <TableRow key={l.id}>
                  <TableCell>
                    <div className="flex flex-col">
                      <span className="font-mono text-sm">
                        {l.part.part_number}
                      </span>
                      <span className="text-xs text-muted-foreground">
                        {l.part.description}
                      </span>
                    </div>
                  </TableCell>
                  <TableCell className="text-right">{l.qty}</TableCell>
                  <TableCell className="text-right">
                    {formatMoney(l.unit_sell_price, l.currency ?? 'TZS')}
                  </TableCell>
                  <TableCell>
                    {l.is_warranty ? (
                      <Badge variant="success">IW</Badge>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </TableCell>
                  <TableCell>
                    {l.status === 'RESERVED' ? (
                      <Badge variant="warning">Reserved</Badge>
                    ) : (
                      <Badge variant="secondary">Consumed</Badge>
                    )}
                  </TableCell>
                  {(canReserve || canConsume) && (
                    <TableCell>
                      {l.status === 'RESERVED' && (
                        <div className="flex gap-1">
                          {canConsume && (
                            <Button
                              variant="ghost"
                              size="sm"
                              disabled={busy}
                              onClick={() => consume.mutate(l.id)}
                            >
                              Consume
                            </Button>
                          )}
                          {canReserve && (
                            <Button
                              variant="ghost"
                              size="sm"
                              disabled={busy}
                              onClick={() => remove.mutate(l.id)}
                            >
                              Remove
                            </Button>
                          )}
                        </div>
                      )}
                    </TableCell>
                  )}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
      {lines.length === 0 && !parts.isPending && (
        <p className="text-sm text-muted-foreground">
          No parts on this job yet.
        </p>
      )}

      {canConsume && reserved.length > 0 && (
        <div>
          <Button
            variant="outline"
            disabled={busy}
            onClick={() => consumeAll.mutate()}
          >
            Consume all reserved ({reserved.length})
          </Button>
        </div>
      )}

      {canReserve && (
        <div className="flex flex-wrap items-end gap-2 border-t pt-4">
          <FormField label="Add part" htmlFor="jp-part" className="min-w-64">
            <Select
              id="jp-part"
              value={partId}
              onChange={(e) => setPartId(e.target.value)}
            >
              <option value="">— select a part —</option>
              {catalogue.data?.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.part_number} — {p.description}
                </option>
              ))}
            </Select>
          </FormField>
          <FormField label="Qty" htmlFor="jp-qty" className="w-24">
            <Input
              id="jp-qty"
              inputMode="numeric"
              value={qty}
              onChange={(e) => setQty(e.target.value)}
            />
          </FormField>
          <Button
            disabled={busy || !partId || Number(qty) < 1}
            onClick={() => add.mutate()}
          >
            Reserve
          </Button>
        </div>
      )}
    </div>
  )
}

/**
 * Job detail (Task 1.5, DESIGN.md §8 item 5). Tabs: Details · Tech report ·
 * Attachments · History · Parts (Task 2.2) · Payment (Phase 3 placeholder).
 * Legal next moves come straight from GET /jobs/{id}'s
 * `allowed_next_transitions` — already permission- and guard-filtered
 * server-side (WorkflowService).
 */
export function JobDetailPage() {
  const { id } = useParams<{ id: string }>()
  const { can } = useAuth()

  const jobQuery = useQuery({
    queryKey: ['job', id],
    queryFn: async () => (await api.get<JobDetailWire>(`/jobs/${id}`)).data,
    enabled: Boolean(id),
  })

  const serial = jobQuery.data?.device.imei_serial ?? ''
  const warranty = useQuery({
    queryKey: ['warranty-lookup', serial],
    enabled: can('customer.read') && serial.length >= 4,
    queryFn: async () =>
      (
        await api.get<WarrantyRegistrationWire | ''>(
          '/warranty-registrations/lookup',
          { params: { serial } },
        )
      ).data,
  })
  const coverage =
    warranty.data && typeof warranty.data === 'object' && 'id' in warranty.data
      ? (warranty.data as WarrantyRegistrationWire)
      : null

  const transition = useJobTransition()

  if (jobQuery.isPending) return <p className="text-sm text-muted-foreground">Loading job…</p>
  if (jobQuery.isError)
    return <p className="text-sm text-destructive">{apiErrorMessage(jobQuery.error)}</p>
  const job = jobQuery.data
  if (!job) return null

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader className="flex-row items-center justify-between">
          <div>
            <CardTitle className="text-lg">{job.job_no}</CardTitle>
            <p className="text-sm text-muted-foreground">
              <Link to={`/customers/${job.customer.id}`} className="hover:underline">
                {job.customer.name}
              </Link>{' '}
              · {job.device.brand} {job.device.model ?? ''} · Received{' '}
              {formatDateTime(job.received_at)}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Badge variant="outline" title={job.branch_name}>
              {job.branch_code}
            </Badge>
            {warrantyBadge(job.warranty_status)}
            <Badge>{job.state_label}</Badge>
          </div>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {coverage && (
            <div
              className={
                'flex items-center gap-3 rounded-lg border p-3 text-sm ' +
                (coverage.is_expired
                  ? 'border-amber-500/30 bg-amber-500/10'
                  : 'border-emerald-500/30 bg-emerald-500/10')
              }
            >
              <ShieldCheck
                className={
                  'size-5 shrink-0 ' +
                  (coverage.is_expired
                    ? 'text-amber-600 dark:text-amber-400'
                    : 'text-emerald-600 dark:text-emerald-400')
                }
              />
              <span>
                {coverage.is_expired
                  ? `Warranty expired ${formatDate(coverage.expiry_date)}`
                  : `Under ${WARRANTY_KIND_LABEL[coverage.kind]} warranty · covered until ${formatDate(coverage.expiry_date)}`}
                <span className="text-muted-foreground">
                  {' '}· {coverage.product_name}
                </span>
              </span>
              <Button asChild variant="ghost" size="xs" className="ml-auto">
                <Link to="/warranties">View</Link>
              </Button>
            </div>
          )}
          {job.allowed_next_transitions.length > 0 && (
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs text-muted-foreground">Next:</span>
              {job.allowed_next_transitions.map((t) => (
                <Button
                  key={t.to_state_code}
                  size="sm"
                  variant="outline"
                  disabled={transition.isPending}
                  onClick={() => transition.mutate({ jobId: job.id, toStateCode: t.to_state_code })}
                >
                  {t.to_label}
                  {t.requires_approval && (
                    <Badge variant="warning" className="ml-1">
                      needs approval
                    </Badge>
                  )}
                </Button>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <Tabs defaultValue="details">
        <TabsList>
          <TabsTrigger value="details">Details</TabsTrigger>
          <TabsTrigger value="tech">Tech report</TabsTrigger>
          <TabsTrigger value="attachments">Attachments</TabsTrigger>
          {can('audit.read') && <TabsTrigger value="history">History</TabsTrigger>}
          <TabsTrigger value="parts">Parts</TabsTrigger>
          <TabsTrigger value="payment" disabled>
            Payment
          </TabsTrigger>
        </TabsList>
        <TabsContent value="details">
          <DetailsTab job={job} />
        </TabsContent>
        <TabsContent value="tech">
          <TechReportTab job={job} />
        </TabsContent>
        <TabsContent value="attachments">
          <AttachmentsTab job={job} />
        </TabsContent>
        {can('audit.read') && (
          <TabsContent value="history">
            <HistoryTab job={job} />
          </TabsContent>
        )}
        <TabsContent value="parts">
          <PartsTab job={job} />
        </TabsContent>
        <TabsContent value="payment">
          <p className="text-sm text-muted-foreground">
            Payment / warranty claim arrives in Phase 3/4.
          </p>
        </TabsContent>
      </Tabs>
    </div>
  )
}
