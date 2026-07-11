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
import { api, apiErrorMessage } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { formatDateTime } from '@/lib/format'
import type {
  BranchWire,
  PartWire,
  StockTransferStatus,
  TransferDispatchResult,
  TransferWire,
} from '@/lib/types'

const STATUSES: StockTransferStatus[] = [
  'DRAFT',
  'DISPATCHED',
  'RECEIVED',
  'CANCELLED',
]

function statusBadge(status: StockTransferStatus) {
  switch (status) {
    case 'DRAFT':
      return <Badge variant="secondary">Draft</Badge>
    case 'DISPATCHED':
      return <Badge variant="warning">In transit</Badge>
    case 'RECEIVED':
      return <Badge variant="success">Received</Badge>
    default:
      return <Badge variant="destructive">Cancelled</Badge>
  }
}

interface DraftLine {
  part_id: string
  qty: string
}

/**
 * Inter-branch transfers (Task 2.3, §4.4): draft → dispatch → receive.
 * Dispatch moves stock out of the source and into the destination's in-transit;
 * receive lands it. Over-threshold dispatches are held for approval.
 */
export function TransfersPage() {
  const { can } = useAuth()
  const queryClient = useQueryClient()
  const [page, setPage] = useState(1)
  const [status, setStatus] = useState('')
  const [dialogOpen, setDialogOpen] = useState(false)
  const [fromBranch, setFromBranch] = useState('')
  const [toBranch, setToBranch] = useState('')
  const [notes, setNotes] = useState('')
  const [lines, setLines] = useState<DraftLine[]>([{ part_id: '', qty: '1' }])

  const canTransfer = can('inventory.transfer')

  const branches = useQuery({
    queryKey: ['branches', 'all'],
    queryFn: async () =>
      (
        await api.get<PaginatedResponse<BranchWire>>('/branches', {
          params: { page_size: 100 },
        })
      ).data.data,
  })

  const parts = useQuery({
    queryKey: ['parts', 'options'],
    enabled: canTransfer,
    queryFn: async () =>
      (
        await api.get<PaginatedResponse<PartWire>>('/parts', {
          params: { page_size: 100, active: true },
        })
      ).data.data,
  })

  const transfers = useQuery({
    queryKey: ['transfers', page, status],
    queryFn: async () =>
      (
        await api.get<PaginatedResponse<TransferWire>>('/transfers', {
          params: { page, page_size: 20, ...(status ? { status } : {}) },
        })
      ).data,
  })

  const invalidate = async () => {
    await queryClient.invalidateQueries({ queryKey: ['transfers'] })
    await queryClient.invalidateQueries({ queryKey: ['inventory'] })
  }

  function openCreate() {
    setFromBranch('')
    setToBranch('')
    setNotes('')
    setLines([{ part_id: '', qty: '1' }])
    setDialogOpen(true)
  }

  const create = useMutation({
    mutationFn: async () =>
      (
        await api.post<TransferWire>('/transfers', {
          from_branch_id: fromBranch,
          to_branch_id: toBranch,
          notes: notes || undefined,
          lines: lines
            .filter((l) => l.part_id && Number(l.qty) > 0)
            .map((l) => ({ part_id: l.part_id, qty: Number(l.qty) })),
        })
      ).data,
    onSuccess: async () => {
      toast.success('Transfer drafted')
      setDialogOpen(false)
      await invalidate()
    },
    onError: (e) => toast.error(apiErrorMessage(e)),
  })

  const dispatch = useMutation({
    mutationFn: async (id: string) =>
      (await api.post<TransferDispatchResult>(`/transfers/${id}/dispatch`))
        .data,
    onSuccess: async (res) => {
      if (res.held) {
        toast.warning('Dispatch sent for approval — nothing moved yet')
      } else {
        toast.success('Transfer dispatched')
      }
      await invalidate()
    },
    onError: (e) => toast.error(apiErrorMessage(e)),
  })

  const receive = useMutation({
    mutationFn: async (id: string) => api.post(`/transfers/${id}/receive`),
    onSuccess: async () => {
      toast.success('Transfer received')
      await invalidate()
    },
    onError: (e) => toast.error(apiErrorMessage(e)),
  })

  const cancel = useMutation({
    mutationFn: async (id: string) => api.post(`/transfers/${id}/cancel`),
    onSuccess: async () => {
      toast.success('Transfer cancelled')
      await invalidate()
    },
    onError: (e) => toast.error(apiErrorMessage(e)),
  })

  const busy =
    dispatch.isPending || receive.isPending || cancel.isPending
  const validLines = lines.filter((l) => l.part_id && Number(l.qty) > 0)
  const canSubmit =
    fromBranch !== '' &&
    toBranch !== '' &&
    fromBranch !== toBranch &&
    validLines.length > 0

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <Select
          value={status}
          onChange={(e) => {
            setStatus(e.target.value)
            setPage(1)
          }}
          className="w-44"
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
        {canTransfer && <Button onClick={openCreate}>New transfer</Button>}
      </div>

      {transfers.isPending && (
        <p className="text-sm text-muted-foreground">Loading…</p>
      )}
      {transfers.isError && (
        <p className="text-sm text-destructive">
          {apiErrorMessage(transfers.error)}
        </p>
      )}
      {transfers.data && (
        <div className="rounded-xl border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Transfer</TableHead>
                <TableHead>Route</TableHead>
                <TableHead>Items</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Created</TableHead>
                {canTransfer && <TableHead className="w-48" />}
              </TableRow>
            </TableHeader>
            <TableBody>
              {transfers.data.data.length === 0 && (
                <TableRow>
                  <TableCell
                    colSpan={6}
                    className="text-center text-muted-foreground"
                  >
                    No transfers
                  </TableCell>
                </TableRow>
              )}
              {transfers.data.data.map((t) => (
                <TableRow key={t.id}>
                  <TableCell className="font-mono text-sm">
                    {t.transfer_no}
                  </TableCell>
                  <TableCell>
                    {t.from_branch_code} → {t.to_branch_code}
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {t.lines.reduce((n, l) => n + l.qty, 0)} units ·{' '}
                    {t.lines.length} part{t.lines.length === 1 ? '' : 's'}
                  </TableCell>
                  <TableCell>{statusBadge(t.status)}</TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {formatDateTime(t.created_at)}
                  </TableCell>
                  {canTransfer && (
                    <TableCell>
                      <div className="flex gap-1">
                        {t.status === 'DRAFT' && (
                          <>
                            <Button
                              variant="ghost"
                              size="sm"
                              disabled={busy}
                              onClick={() => dispatch.mutate(t.id)}
                            >
                              Dispatch
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              disabled={busy}
                              onClick={() => cancel.mutate(t.id)}
                            >
                              Cancel
                            </Button>
                          </>
                        )}
                        {t.status === 'DISPATCHED' && (
                          <Button
                            variant="ghost"
                            size="sm"
                            disabled={busy}
                            onClick={() => receive.mutate(t.id)}
                          >
                            Receive
                          </Button>
                        )}
                      </div>
                    </TableCell>
                  )}
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <div className="px-3 pb-3">
            <Pager
              page={transfers.data.page}
              pageSize={transfers.data.page_size}
              total={transfers.data.total}
              onPageChange={setPage}
            />
          </div>
        </div>
      )}

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>New transfer</DialogTitle>
            <DialogDescription>
              Draft an inter-branch transfer. Stock moves only when you dispatch
              it.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <FormField label="From branch" htmlFor="tr-from">
                <Select
                  id="tr-from"
                  value={fromBranch}
                  onChange={(e) => setFromBranch(e.target.value)}
                >
                  <option value="">— select —</option>
                  {branches.data?.map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.code} — {b.name}
                    </option>
                  ))}
                </Select>
              </FormField>
              <FormField label="To branch" htmlFor="tr-to">
                <Select
                  id="tr-to"
                  value={toBranch}
                  onChange={(e) => setToBranch(e.target.value)}
                >
                  <option value="">— select —</option>
                  {branches.data?.map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.code} — {b.name}
                    </option>
                  ))}
                </Select>
              </FormField>
            </div>

            <div className="flex flex-col gap-2">
              <span className="text-sm font-medium">Lines</span>
              {lines.map((line, i) => (
                <div key={i} className="flex items-center gap-2">
                  <Select
                    value={line.part_id}
                    onChange={(e) =>
                      setLines((ls) =>
                        ls.map((l, j) =>
                          j === i ? { ...l, part_id: e.target.value } : l,
                        ),
                      )
                    }
                    className="flex-1"
                    aria-label="Part"
                  >
                    <option value="">— select a part —</option>
                    {parts.data?.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.part_number} — {p.description}
                      </option>
                    ))}
                  </Select>
                  <Input
                    inputMode="numeric"
                    value={line.qty}
                    onChange={(e) =>
                      setLines((ls) =>
                        ls.map((l, j) =>
                          j === i ? { ...l, qty: e.target.value } : l,
                        ),
                      )
                    }
                    className="w-20"
                    aria-label="Quantity"
                  />
                  {lines.length > 1 && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() =>
                        setLines((ls) => ls.filter((_, j) => j !== i))
                      }
                    >
                      ✕
                    </Button>
                  )}
                </div>
              ))}
              <div>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() =>
                    setLines((ls) => [...ls, { part_id: '', qty: '1' }])
                  }
                >
                  Add line
                </Button>
              </div>
            </div>

            <FormField label="Notes (optional)" htmlFor="tr-notes">
              <Input
                id="tr-notes"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
              />
            </FormField>
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={() => setDialogOpen(false)}
            >
              Cancel
            </Button>
            <Button
              disabled={!canSubmit || create.isPending}
              onClick={() => create.mutate()}
            >
              {create.isPending ? 'Saving…' : 'Create draft'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
