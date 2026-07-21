import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Download, FileText, Upload } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import type { PaginatedResponse } from '@triserve/shared'
import { FormField } from '@/components/shared/form-field'
import { JobPicker } from '@/components/shared/job-picker'
import { Pager } from '@/components/shared/pager'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { api, apiErrorMessage } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { decimalToMinor, formatDate, formatMoney, minorToDecimal } from '@/lib/format'
import type {
  ClaimJobMatch,
  LabourCode,
  ParsedClaim,
  WarrantyClaimStatus,
  WarrantyClaimWire,
} from '@/lib/types'

const STATUSES: WarrantyClaimStatus[] = [
  'DRAFT',
  'SUBMITTED',
  'APPROVED',
  'REJECTED',
  'PAID',
  'CANCELLED',
]
const LABOUR_CODES: LabourCode[] = ['FEM', 'LEM', 'SEM']

function statusBadge(status: WarrantyClaimStatus) {
  switch (status) {
    case 'APPROVED':
    case 'PAID':
      return <Badge variant="success">{status === 'PAID' ? 'Paid' : 'Approved'}</Badge>
    case 'SUBMITTED':
      return <Badge variant="warning">Submitted</Badge>
    case 'REJECTED':
    case 'CANCELLED':
      return <Badge variant="destructive">{status === 'REJECTED' ? 'Rejected' : 'Cancelled'}</Badge>
    default:
      return <Badge variant="secondary">Draft</Badge>
  }
}

/**
 * Warranty claims (Task 4.1, §4.7) — the IW side. List/filter claims and open
 * a DRAFT claim (USD) against a job; DRAFTs are editable. Submit/reconcile land
 * in Task 4.2.
 */
export function WarrantyClaimsPage() {
  const { can } = useAuth()
  const queryClient = useQueryClient()
  const [page, setPage] = useState(1)
  const [statusFilter, setStatusFilter] = useState('')

  const [dialogOpen, setDialogOpen] = useState(false)
  const [editId, setEditId] = useState<string | null>(null)
  const [jobId, setJobId] = useState('')
  const [jobLabel, setJobLabel] = useState<string | null>(null)
  const [amount, setAmount] = useState('')
  const [labourCode, setLabourCode] = useState<'' | LabourCode>('')
  const [claimNo, setClaimNo] = useState('')
  const [notes, setNotes] = useState('')

  const [importOpen, setImportOpen] = useState(false)
  const [importCsv, setImportCsv] = useState('')

  /** The last GSPN claim-detail PDF read, shown alongside the create dialog. */
  const [pdfDraft, setPdfDraft] = useState<ParsedClaim | null>(null)

  const canCreate = can('warranty.claim.create')
  const canSubmit = can('warranty.claim.submit')
  const canReconcile = can('warranty.claim.reconcile')
  const canRead = can('warranty.claim.read')

  const claims = useQuery({
    queryKey: ['warranty-claims', page, statusFilter],
    queryFn: async () =>
      (
        await api.get<PaginatedResponse<WarrantyClaimWire>>('/warranty-claims', {
          params: {
            page,
            page_size: 20,
            ...(statusFilter ? { status: statusFilter } : {}),
          },
        })
      ).data,
  })

  const invalidate = async () =>
    queryClient.invalidateQueries({ queryKey: ['warranty-claims'] })

  function openCreate() {
    setEditId(null)
    setJobId('')
    setJobLabel(null)
    setAmount('')
    setLabourCode('')
    setClaimNo('')
    setNotes('')
    setPdfDraft(null)
    setJobMatches([])
    setDialogOpen(true)
  }

  /**
   * Read a GSPN Warranty Claim Detail PDF into the create dialog.
   *
   * GSPN exports no CSV for claim detail, so the printed PDF is the only way
   * in short of retyping. It cannot tell us WHICH of our jobs the claim
   * belongs to — it identifies the handset, not the job — so the advisor
   * still picks that, and nothing is saved until they do.
   */
  const importPdfMut = useMutation({
    mutationFn: async (file: File) => {
      const fd = new FormData()
      fd.append('file', file)
      return (
        await api.post<ParsedClaim>('/warranty-claims/import/gspn-pdf', fd)
      ).data
    },
    onSuccess: (draft) => {
      setEditId(null)
      setJobId('')
      setJobLabel(null)
      setLabourCode('')
      setClaimNo(draft.claim_no ?? '')
      setAmount(draft.claim_amount_usd ? minorToDecimal(draft.claim_amount_usd) : '')
      setNotes(
        [
          draft.samsung_ref_no && `Samsung ref ${draft.samsung_ref_no}`,
          draft.ticket_no && `ticket ${draft.ticket_no}`,
          draft.repair_description,
        ]
          .filter(Boolean)
          .join(' · '),
      )
      setPdfDraft(draft)
      setDialogOpen(true)
      // Suggest which job this claim belongs to. The PDF names the handset,
      // never the job, so this is a lookup the operator confirms.
      if (draft.serial) matchJobs.mutate(draft.serial)
      else setJobMatches([])
    },
    onError: (e) => toast.error(apiErrorMessage(e)),
  })

  const [jobMatches, setJobMatches] = useState<ClaimJobMatch[]>([])

  const matchJobs = useMutation({
    mutationFn: async (serial: string) =>
      (
        await api.get<ClaimJobMatch[]>('/warranty-claims/match', {
          params: { serial },
        })
      ).data,
    onSuccess: (matches) => {
      setJobMatches(matches)
      // Exactly one candidate and it has no claim yet — preselect it, but
      // still show it so the operator can see what was chosen for them.
      const only = matches.length === 1 ? matches[0] : null
      if (only && only.existing_claim_ids.length === 0) {
        setJobId(only.job_id)
        setJobLabel(`${only.job_no} · ${only.customer_name}`)
      }
    },
    // A failed suggestion is not a failed import — the operator can still pick.
    onError: () => setJobMatches([]),
  })

  function openEdit(c: WarrantyClaimWire) {
    setEditId(c.id)
    setJobId(c.job_id)
    setAmount(minorToDecimal(c.claim_amount_usd))
    setLabourCode(c.labour_code ?? '')
    setClaimNo(c.claim_no ?? '')
    setNotes(c.notes ?? '')
    setDialogOpen(true)
  }

  const save = useMutation({
    mutationFn: async () => {
      const amountMinor = decimalToMinor(amount)
      if (!amountMinor) throw new Error('Enter a claim amount in USD')
      const payload = {
        claim_amount_usd: amountMinor,
        labour_code: labourCode || undefined,
        claim_no: claimNo || undefined,
        notes: notes || undefined,
      }
      if (editId) {
        return (
          await api.patch<WarrantyClaimWire>(`/warranty-claims/${editId}`, payload)
        ).data
      }
      if (!jobId) throw new Error('Select a job')
      // Everything the PDF gave us travels with the claim — the split and the
      // part lines are what make a short payment attributable later, so they
      // must not be dropped on save.
      // The API requires the components to sum to the total. If the operator
      // edited the amount away from what the PDF said, the split no longer
      // describes it — send the total alone rather than a contradiction.
      const splitStillApplies =
        pdfDraft?.claim_amount_usd != null &&
        pdfDraft.claim_amount_usd === amountMinor
      const detail = pdfDraft
        ? {
            samsung_ref_no: pdfDraft.samsung_ref_no ?? undefined,
            ticket_no: pdfDraft.ticket_no ?? undefined,
            gspn_status: pdfDraft.gspn_status ?? undefined,
            ...(splitStillApplies
              ? {
                  labour_amount_usd: pdfDraft.labour_amount_usd ?? undefined,
                  parts_amount_usd: pdfDraft.parts_amount_usd ?? undefined,
                  shipping_amount_usd: pdfDraft.shipping_amount_usd ?? undefined,
                  tax_amount_usd: pdfDraft.tax_amount_usd ?? undefined,
                }
              : {}),
            repair_received_at: pdfDraft.repair_received_at ?? undefined,
            completed_at: pdfDraft.completed_at ?? undefined,
            delivered_at: pdfDraft.delivered_at ?? undefined,
            lines: pdfDraft.lines.length
              ? pdfDraft.lines.map((l) => ({
                  part_no: l.part_no,
                  description: l.description ?? undefined,
                  location: l.location ?? undefined,
                  qty: l.qty,
                  unit_price_usd: l.unit_price_usd ?? '0',
                  amount_usd: l.amount_usd ?? undefined,
                  part_serial_no: l.part_serial_no ?? undefined,
                  invoice_no: l.invoice_no ?? undefined,
                }))
              : undefined,
          }
        : {}
      return (
        await api.post<WarrantyClaimWire>('/warranty-claims', {
          job_id: jobId,
          ...payload,
          ...detail,
        })
      ).data
    },
    onSuccess: async () => {
      toast.success(editId ? 'Claim updated' : 'Claim created')
      setDialogOpen(false)
      setPdfDraft(null)
      setJobMatches([])
      await invalidate()
    },
    onError: (e) =>
      toast.error(e instanceof Error ? e.message : apiErrorMessage(e)),
  })

  const submitClaim = useMutation({
    mutationFn: async (c: WarrantyClaimWire) => {
      const claimNo =
        c.claim_no ??
        window.prompt('Enter the Samsung claim number to submit')?.trim()
      if (!claimNo) throw new Error('cancelled')
      return (
        await api.post<WarrantyClaimWire>(`/warranty-claims/${c.id}/submit`, {
          claim_no: claimNo,
        })
      ).data
    },
    onSuccess: async () => {
      toast.success('Claim submitted to Samsung')
      await invalidate()
    },
    onError: (e) => {
      if (e instanceof Error && e.message === 'cancelled') return
      toast.error(apiErrorMessage(e))
    },
  })

  const reconcileClaim = useMutation({
    mutationFn: async (args: {
      c: WarrantyClaimWire
      outcome: 'APPROVED' | 'REJECTED' | 'PAID'
    }) => {
      const body: Record<string, unknown> = { outcome: args.outcome }
      if (args.outcome === 'PAID') {
        const input = window.prompt(
          'Amount Samsung reimbursed (USD)',
          minorToDecimal(args.c.claim_amount_usd),
        )
        if (input === null) throw new Error('cancelled')
        const minor = decimalToMinor(input)
        if (minor) body.reimbursed_amount_usd = minor
      }
      return (
        await api.post<WarrantyClaimWire>(
          `/warranty-claims/${args.c.id}/reconcile`,
          body,
        )
      ).data
    },
    onSuccess: async (_d, args) => {
      toast.success(
        args.outcome === 'PAID'
          ? 'Reimbursement recorded'
          : `Claim ${args.outcome.toLowerCase()}`,
      )
      await invalidate()
    },
    onError: (e) => {
      if (e instanceof Error && e.message === 'cancelled') return
      toast.error(apiErrorMessage(e))
    },
  })

  // GSPN bridge (E13): download claims CSV to file with Samsung.
  const exportCsv = useMutation({
    mutationFn: async () => {
      const res = await api.get<string>('/warranty-claims/export', {
        responseType: 'text',
        params: statusFilter ? { status: statusFilter } : undefined,
      })
      const blob = new Blob([res.data], { type: 'text/csv' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = 'gspn-claims.csv'
      a.click()
      URL.revokeObjectURL(url)
    },
    onError: (e) => toast.error(apiErrorMessage(e)),
  })

  // GSPN bridge (E13): apply Samsung's reconciliation CSV.
  const importCsvMut = useMutation({
    mutationFn: async () =>
      (
        await api.post<{
          total: number
          applied: number
          errors: { claim_no: string; reason: string }[]
        }>('/warranty-claims/import', { csv: importCsv })
      ).data,
    onSuccess: async (report) => {
      if (report.errors.length === 0) {
        toast.success(`Applied ${report.applied} of ${report.total} rows`)
      } else {
        toast.warning(
          `Applied ${report.applied}/${report.total}; ${report.errors.length} row(s) skipped`,
        )
      }
      setImportOpen(false)
      setImportCsv('')
      await invalidate()
    },
    onError: (e) => toast.error(apiErrorMessage(e)),
  })

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
              {s}
            </option>
          ))}
        </Select>
        <div className="flex-1" />
        {canRead && (
          <Button
            variant="outline"
            className="gap-1.5"
            onClick={() => exportCsv.mutate()}
            disabled={exportCsv.isPending}
            title="Download claims as a GSPN CSV"
          >
            <Download className="size-4" /> Export GSPN
          </Button>
        )}
        {canReconcile && (
          <Button
            variant="outline"
            className="gap-1.5"
            onClick={() => setImportOpen(true)}
            title="Apply a GSPN reconciliation CSV"
          >
            <Upload className="size-4" /> Import GSPN
          </Button>
        )}
        {canCreate && (
          <Button
            variant="outline"
            className="gap-1.5"
            asChild
            title="Read a GSPN Warranty Claim Detail PDF"
          >
            <label>
              <FileText className="size-4" />
              {importPdfMut.isPending ? 'Reading…' : 'Read claim PDF'}
              <input
                type="file"
                accept="application/pdf"
                className="hidden"
                disabled={importPdfMut.isPending}
                onChange={(e) => {
                  const file = e.target.files?.[0]
                  if (file) importPdfMut.mutate(file)
                  // Let the same file be picked again after a failed read.
                  e.target.value = ''
                }}
              />
            </label>
          </Button>
        )}
        {canCreate && <Button onClick={openCreate}>New claim</Button>}
      </div>

      {claims.isPending && <p className="text-sm text-muted-foreground">Loading…</p>}
      {claims.isError && (
        <p className="text-sm text-destructive">{apiErrorMessage(claims.error)}</p>
      )}
      {claims.data && (
        <div className="overflow-hidden rounded-xl border bg-card shadow-sm">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Claim no.</TableHead>
                <TableHead>Job</TableHead>
                <TableHead>Branch</TableHead>
                <TableHead>Labour</TableHead>
                <TableHead className="text-right">Claim (USD)</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Created</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {claims.data.data.length === 0 && (
                <TableRow>
                  <TableCell colSpan={8} className="text-center text-muted-foreground">
                    No warranty claims.
                  </TableCell>
                </TableRow>
              )}
              {claims.data.data.map((c) => (
                <TableRow key={c.id}>
                  <TableCell className="font-medium">
                    {c.claim_no ?? <span className="text-muted-foreground">—</span>}
                  </TableCell>
                  <TableCell>{c.job_no}</TableCell>
                  <TableCell>{c.branch_code}</TableCell>
                  <TableCell>{c.labour_code ?? '—'}</TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatMoney(c.claim_amount_usd, 'USD')}
                  </TableCell>
                  <TableCell>{statusBadge(c.status)}</TableCell>
                  <TableCell className="text-muted-foreground">
                    {formatDate(c.created_at)}
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex justify-end gap-1">
                      {canCreate && c.status === 'DRAFT' && (
                        <Button variant="ghost" size="sm" onClick={() => openEdit(c)}>
                          Edit
                        </Button>
                      )}
                      {canSubmit && c.status === 'DRAFT' && (
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => submitClaim.mutate(c)}
                        >
                          Submit
                        </Button>
                      )}
                      {canReconcile && c.status === 'SUBMITTED' && (
                        <>
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() =>
                              reconcileClaim.mutate({ c, outcome: 'APPROVED' })
                            }
                          >
                            Approve
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() =>
                              reconcileClaim.mutate({ c, outcome: 'REJECTED' })
                            }
                          >
                            Reject
                          </Button>
                        </>
                      )}
                      {canReconcile && c.status === 'APPROVED' && (
                        <Button
                          size="sm"
                          onClick={() =>
                            reconcileClaim.mutate({ c, outcome: 'PAID' })
                          }
                        >
                          Mark paid
                        </Button>
                      )}
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      {claims.data && (
        <Pager
          page={claims.data.page}
          pageSize={claims.data.page_size}
          total={claims.data.total}
          onPageChange={setPage}
        />
      )}

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editId ? 'Edit warranty claim' : 'New warranty claim'}</DialogTitle>
          </DialogHeader>
          <div className="flex flex-col gap-3">
            {pdfDraft && (
              <div className="flex flex-col gap-1.5 rounded-md border bg-muted/40 p-2.5 text-xs">
                <p className="font-medium">Read from the claim PDF</p>
                <p className="text-muted-foreground">
                  {[
                    pdfDraft.model,
                    pdfDraft.serial && `serial ${pdfDraft.serial}`,
                    pdfDraft.customer_name,
                    pdfDraft.gspn_status,
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </p>
                {/* The split the claim was settled on — what makes a short
                    payment attributable later. */}
                <p className="text-muted-foreground">
                  Labour {formatMoney(pdfDraft.labour_amount_usd ?? '0', 'USD')} · Parts{' '}
                  {formatMoney(pdfDraft.parts_amount_usd ?? '0', 'USD')} · Shipping{' '}
                  {formatMoney(pdfDraft.shipping_amount_usd ?? '0', 'USD')} · Tax{' '}
                  {formatMoney(pdfDraft.tax_amount_usd ?? '0', 'USD')}
                </p>
                {pdfDraft.lines.length > 0 && (
                  <p className="text-muted-foreground">
                    {pdfDraft.lines
                      .map((l) => `${l.part_no} ×${l.qty}`)
                      .join(', ')}
                  </p>
                )}
                {/* The PDF identifies the handset, not the job — matched on
                    serial, so several jobs can qualify. */}
                {matchJobs.isPending && (
                  <p className="text-muted-foreground">Looking for the job…</p>
                )}
                {!matchJobs.isPending && jobMatches.length === 0 && (
                  <p className="text-muted-foreground">
                    No job found for serial {pdfDraft.serial ?? '—'} — pick one below.
                  </p>
                )}
                {jobMatches.length > 0 && (
                  <div className="flex flex-col gap-1">
                    <p className="text-muted-foreground">
                      {jobMatches.length === 1
                        ? 'Matched this job by serial:'
                        : `${jobMatches.length} jobs share this serial — pick one:`}
                    </p>
                    {jobMatches.map((m) => (
                      <button
                        key={m.job_id}
                        type="button"
                        className={
                          'rounded-sm border px-2 py-1 text-left hover:bg-muted ' +
                          (jobId === m.job_id ? 'border-primary bg-muted' : '')
                        }
                        onClick={() => {
                          setJobId(m.job_id)
                          setJobLabel(`${m.job_no} · ${m.customer_name}`)
                        }}
                      >
                        <span className="font-medium">{m.job_no}</span>{' '}
                        <span className="text-muted-foreground">
                          {m.customer_name} · {m.state_label} · {m.branch_code} ·{' '}
                          {formatDate(m.received_at)}
                        </span>
                        {/* Filing a second claim against an already-claimed
                            job is nearly always a mistake. */}
                        {m.existing_claim_ids.length > 0 && (
                          <span className="text-amber-700 dark:text-amber-400">
                            {' '}
                            · already has {m.existing_claim_ids.length} claim
                            {m.existing_claim_ids.length > 1 ? 's' : ''}
                          </span>
                        )}
                      </button>
                    ))}
                  </div>
                )}
                {pdfDraft.warnings.map((w) => (
                  <p key={w} className="text-amber-700 dark:text-amber-400">
                    {w}
                  </p>
                ))}
              </div>
            )}
            {!editId && (
              <FormField label="Job" htmlFor="claim-job">
                <JobPicker
                  selectedLabel={jobLabel}
                  onSelect={(j) => {
                    setJobId(j.id)
                    setJobLabel(
                      `${j.job_no}${j.fault_reported ? ` · ${j.fault_reported}` : ''}`,
                    )
                  }}
                  onClear={() => {
                    setJobId('')
                    setJobLabel(null)
                  }}
                />
              </FormField>
            )}
            <FormField label="Claim amount (USD)">
              <Input
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                placeholder="57.68"
                inputMode="decimal"
              />
            </FormField>
            <FormField label="Labour code">
              <Select
                value={labourCode}
                onChange={(e) => setLabourCode(e.target.value as '' | LabourCode)}
              >
                <option value="">None</option>
                {LABOUR_CODES.map((l) => (
                  <option key={l} value={l}>
                    {l}
                  </option>
                ))}
              </Select>
            </FormField>
            <FormField label="Samsung claim no. (optional)">
              <Input
                value={claimNo}
                onChange={(e) => setClaimNo(e.target.value)}
                placeholder="691010338615"
              />
            </FormField>
            <FormField label="Notes (optional)">
              <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} />
            </FormField>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)}>
              Cancel
            </Button>
            <Button onClick={() => save.mutate()} disabled={save.isPending}>
              {editId ? 'Save' : 'Create claim'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={importOpen} onOpenChange={setImportOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Import GSPN reconciliation</DialogTitle>
          </DialogHeader>
          <div className="flex flex-col gap-3">
            <p className="text-sm text-muted-foreground">
              Paste (or upload) Samsung's decision CSV. Columns:{' '}
              <code className="rounded bg-muted px-1 text-xs">
                claim_no, outcome, reimbursed_usd
              </code>
              . Outcome is APPROVED, REJECTED or PAID; reimbursed_usd (dollars) is
              used for PAID.
            </p>
            <Input
              type="file"
              accept=".csv,text/csv"
              onChange={(e) => {
                const file = e.target.files?.[0]
                if (file) void file.text().then(setImportCsv)
              }}
            />
            <Textarea
              rows={7}
              value={importCsv}
              onChange={(e) => setImportCsv(e.target.value)}
              placeholder={'claim_no,outcome,reimbursed_usd\n691010338615,PAID,95.00'}
              className="font-mono text-xs"
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setImportOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={() => importCsvMut.mutate()}
              disabled={importCsvMut.isPending || !importCsv.trim()}
            >
              Apply
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
