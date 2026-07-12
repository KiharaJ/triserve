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
  JobWire,
  LabourCode,
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
  const [amount, setAmount] = useState('')
  const [labourCode, setLabourCode] = useState<'' | LabourCode>('')
  const [claimNo, setClaimNo] = useState('')
  const [notes, setNotes] = useState('')

  const canCreate = can('warranty.claim.create')
  const canSubmit = can('warranty.claim.submit')
  const canReconcile = can('warranty.claim.reconcile')

  // Recent jobs to attach a claim to. Not filtered to IW: a job's warranty
  // status can be corrected here, and legacy/imported jobs are UNKNOWN.
  const jobs = useQuery({
    queryKey: ['jobs', 'warranty-options'],
    enabled: canCreate,
    queryFn: async () =>
      (
        await api.get<PaginatedResponse<JobWire>>('/jobs', {
          params: { page_size: 100 },
        })
      ).data.data,
  })

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
    setAmount('')
    setLabourCode('')
    setClaimNo('')
    setNotes('')
    setDialogOpen(true)
  }

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
      return (
        await api.post<WarrantyClaimWire>('/warranty-claims', {
          job_id: jobId,
          ...payload,
        })
      ).data
    },
    onSuccess: async () => {
      toast.success(editId ? 'Claim updated' : 'Claim created')
      setDialogOpen(false)
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
        {canCreate && <Button onClick={openCreate}>New claim</Button>}
      </div>

      {claims.isPending && <p className="text-sm text-muted-foreground">Loading…</p>}
      {claims.isError && (
        <p className="text-sm text-destructive">{apiErrorMessage(claims.error)}</p>
      )}
      {claims.data && (
        <div className="rounded-xl border">
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
            {!editId && (
              <FormField label="Job (IW)">
                <Select value={jobId} onChange={(e) => setJobId(e.target.value)}>
                  <option value="">Select a job…</option>
                  {(jobs.data ?? []).map((j) => (
                    <option key={j.id} value={j.id}>
                      {j.job_no}
                    </option>
                  ))}
                </Select>
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
    </div>
  )
}
