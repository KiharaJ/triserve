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
  ApprovalEntry,
  ApprovalStatus,
  ApprovalType,
  BranchWire,
} from '@/lib/types'

const STATUSES: ApprovalStatus[] = ['PENDING', 'APPROVED', 'REJECTED']

const TYPES: ApprovalType[] = [
  'PRICE_OVERRIDE',
  'REFUND',
  'INVENTORY_ADJUSTMENT',
  'STOCK_TRANSFER',
  'PURCHASE_ORDER',
  'WARRANTY_CANCELLATION',
  'INVOICE_VOID',
  'REOPEN_JOB',
  'LARGE_CASH_REFUND',
  'MANUAL_JOURNAL',
]

function statusBadge(status: ApprovalStatus) {
  switch (status) {
    case 'PENDING':
      return <Badge variant="warning">Pending</Badge>
    case 'APPROVED':
      return <Badge variant="success">Approved</Badge>
    case 'REJECTED':
      return <Badge variant="destructive">Rejected</Badge>
  }
}

type Decision = { approval: ApprovalEntry; verdict: 'approve' | 'reject' }

/**
 * Approvals inbox (Task 0.7, DESIGN.md §4.11 / E8): PENDING requests for
 * the caller's scope, decided (approve/reject + reason) by holders of
 * 'approval.decide' — Branch Managers and the Super Admin.
 */
export function ApprovalsPage() {
  const { can } = useAuth()
  const queryClient = useQueryClient()
  const [page, setPage] = useState(1)
  const [status, setStatus] = useState<string>('PENDING')
  const [type, setType] = useState<string>('')
  const [decision, setDecision] = useState<Decision | null>(null)
  const [reason, setReason] = useState('')

  const canDecide = can('approval.decide')

  const approvals = useQuery({
    queryKey: ['approvals', page, status, type],
    queryFn: async () =>
      (
        await api.get<PaginatedResponse<ApprovalEntry>>('/approvals', {
          params: {
            page,
            page_size: 20,
            ...(status ? { status } : {}),
            ...(type ? { type } : {}),
          },
        })
      ).data,
  })

  // Branch codes for display; anyone who can see this page holds config.read.
  const branches = useQuery({
    queryKey: ['branches', 'all'],
    queryFn: async () =>
      (
        await api.get<PaginatedResponse<BranchWire>>('/branches', {
          params: { page_size: 100 },
        })
      ).data.data,
  })
  const branchCode = (id: string) =>
    branches.data?.find((b) => b.id === id)?.code ?? '…'

  const decide = useMutation({
    mutationFn: async ({ approval, verdict }: Decision) =>
      (
        await api.post<ApprovalEntry>(`/approvals/${approval.id}/${verdict}`, {
          ...(reason.trim() ? { reason: reason.trim() } : {}),
        })
      ).data,
    onSuccess: async (updated) => {
      toast.success(
        updated.status === 'APPROVED' ? 'Request approved' : 'Request rejected',
      )
      setDecision(null)
      setReason('')
      await queryClient.invalidateQueries({ queryKey: ['approvals'] })
    },
    onError: (e) => toast.error(apiErrorMessage(e)),
  })

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <Select
          value={status}
          onChange={(e) => {
            setStatus(e.target.value)
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
        <Select
          value={type}
          onChange={(e) => {
            setType(e.target.value)
            setPage(1)
          }}
          className="w-56"
          aria-label="Filter by type"
        >
          <option value="">All types</option>
          {TYPES.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </Select>
      </div>

      {approvals.isPending && (
        <p className="text-sm text-muted-foreground">Loading…</p>
      )}
      {approvals.isError && (
        <p className="text-sm text-destructive">
          {apiErrorMessage(approvals.error)}
        </p>
      )}
      {approvals.data && (
        <div className="rounded-xl border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Requested</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>Branch</TableHead>
                <TableHead>Reason</TableHead>
                <TableHead>Status</TableHead>
                {canDecide && <TableHead className="w-44" />}
              </TableRow>
            </TableHeader>
            <TableBody>
              {approvals.data.data.length === 0 && (
                <TableRow>
                  <TableCell
                    colSpan={canDecide ? 6 : 5}
                    className="text-center text-muted-foreground"
                  >
                    Nothing waiting for a decision.
                  </TableCell>
                </TableRow>
              )}
              {approvals.data.data.map((a) => (
                <TableRow key={a.id}>
                  <TableCell>{formatDateTime(a.requested_at)}</TableCell>
                  <TableCell>
                    <Badge variant="outline">{a.type}</Badge>
                  </TableCell>
                  <TableCell className="font-mono">
                    {branchCode(a.branch_id)}
                  </TableCell>
                  <TableCell className="max-w-72 truncate" title={a.reason}>
                    {a.reason}
                  </TableCell>
                  <TableCell>{statusBadge(a.status)}</TableCell>
                  {canDecide && (
                    <TableCell>
                      {a.status === 'PENDING' && (
                        <div className="flex gap-1">
                          <Button
                            size="sm"
                            onClick={() =>
                              setDecision({ approval: a, verdict: 'approve' })
                            }
                          >
                            Approve
                          </Button>
                          <Button
                            variant="destructive"
                            size="sm"
                            onClick={() =>
                              setDecision({ approval: a, verdict: 'reject' })
                            }
                          >
                            Reject
                          </Button>
                        </div>
                      )}
                    </TableCell>
                  )}
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <div className="px-3 pb-3">
            <Pager
              page={approvals.data.page}
              pageSize={approvals.data.page_size}
              total={approvals.data.total}
              onPageChange={setPage}
            />
          </div>
        </div>
      )}

      <Dialog
        open={decision !== null}
        onOpenChange={(open) => {
          if (!open) {
            setDecision(null)
            setReason('')
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {decision?.verdict === 'approve'
                ? 'Approve request'
                : 'Reject request'}
            </DialogTitle>
            <DialogDescription>
              {decision?.approval.type} — “{decision?.approval.reason}”
            </DialogDescription>
          </DialogHeader>
          <FormField
            label={
              decision?.verdict === 'reject'
                ? 'Reason (required)'
                : 'Note (optional)'
            }
            htmlFor="decision-reason"
          >
            <Textarea
              id="decision-reason"
              rows={3}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder={
                decision?.verdict === 'reject'
                  ? 'Why is this being rejected?'
                  : 'Add context for the audit trail…'
              }
            />
          </FormField>
          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() => {
                setDecision(null)
                setReason('')
              }}
            >
              Cancel
            </Button>
            <Button
              variant={
                decision?.verdict === 'reject' ? 'destructive' : 'default'
              }
              disabled={
                decide.isPending ||
                (decision?.verdict === 'reject' && reason.trim() === '')
              }
              onClick={() => decision && decide.mutate(decision)}
            >
              {decide.isPending
                ? 'Saving…'
                : decision?.verdict === 'approve'
                  ? 'Approve'
                  : 'Reject'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
