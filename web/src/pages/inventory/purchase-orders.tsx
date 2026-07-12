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
import { formatDate, formatMoney, majorToMinor } from '@/lib/format'
import type {
  BranchWire,
  PartWire,
  PurchaseOrderStatus,
  PurchaseOrderWire,
  SupplierWire,
} from '@/lib/types'

const STATUSES: PurchaseOrderStatus[] = [
  'DRAFT',
  'SUBMITTED',
  'APPROVED',
  'ORDERED',
  'PARTIALLY_RECEIVED',
  'RECEIVED',
  'CANCELLED',
]

function statusBadge(status: PurchaseOrderStatus) {
  switch (status) {
    case 'DRAFT':
      return <Badge variant="secondary">Draft</Badge>
    case 'SUBMITTED':
      return <Badge variant="warning">Submitted</Badge>
    case 'APPROVED':
      return <Badge variant="default">Approved</Badge>
    case 'ORDERED':
      return <Badge variant="default">Ordered</Badge>
    case 'PARTIALLY_RECEIVED':
      return <Badge variant="warning">Part-received</Badge>
    case 'RECEIVED':
      return <Badge variant="success">Received</Badge>
    default:
      return <Badge variant="destructive">Cancelled</Badge>
  }
}

interface DraftLine {
  part_id: string
  qty: string
  unit_cost: string
}

/**
 * Purchase orders (Task 2.6, §4.4b): draft → submit → (approve) → order.
 * Large orders (≥ the PURCHASE_ORDER threshold) must be approved before they
 * can be ordered. Receiving against a PO arrives in Task 2.7 (GRN).
 */
export function PurchaseOrdersPage() {
  const { can } = useAuth()
  const queryClient = useQueryClient()
  const [page, setPage] = useState(1)
  const [status, setStatus] = useState('')
  const [dialogOpen, setDialogOpen] = useState(false)
  const [supplierId, setSupplierId] = useState('')
  const [branchId, setBranchId] = useState('')
  const [tax, setTax] = useState('')
  const [shipping, setShipping] = useState('')
  const [notes, setNotes] = useState('')
  const [lines, setLines] = useState<DraftLine[]>([
    { part_id: '', qty: '1', unit_cost: '' },
  ])
  // Receive dialog state: the PO being received + per-line qty/bin inputs.
  const [receiveTarget, setReceiveTarget] = useState<PurchaseOrderWire | null>(
    null,
  )
  const [receiveLines, setReceiveLines] = useState<
    Record<string, { qty: string; bin: string }>
  >({})
  const [deliveryRef, setDeliveryRef] = useState('')

  const canCreate = can('po.create')
  const canApprove = can('po.approve')
  const canReceive = can('grn.receive')

  const branches = useQuery({
    queryKey: ['branches', 'all'],
    queryFn: async () =>
      (
        await api.get<PaginatedResponse<BranchWire>>('/branches', {
          params: { page_size: 100 },
        })
      ).data.data,
  })
  const suppliers = useQuery({
    queryKey: ['suppliers', 'options'],
    enabled: canCreate,
    queryFn: async () =>
      (
        await api.get<PaginatedResponse<SupplierWire>>('/suppliers', {
          params: { page_size: 100, active: true },
        })
      ).data.data,
  })
  const parts = useQuery({
    queryKey: ['parts', 'options'],
    enabled: canCreate,
    queryFn: async () =>
      (
        await api.get<PaginatedResponse<PartWire>>('/parts', {
          params: { page_size: 100, active: true },
        })
      ).data.data,
  })

  const pos = useQuery({
    queryKey: ['purchase-orders', page, status],
    queryFn: async () =>
      (
        await api.get<PaginatedResponse<PurchaseOrderWire>>(
          '/purchase-orders',
          { params: { page, page_size: 20, ...(status ? { status } : {}) } },
        )
      ).data,
  })

  const invalidate = async () => {
    await queryClient.invalidateQueries({ queryKey: ['purchase-orders'] })
  }

  function openCreate() {
    setSupplierId('')
    setBranchId('')
    setTax('')
    setShipping('')
    setNotes('')
    setLines([{ part_id: '', qty: '1', unit_cost: '' }])
    setDialogOpen(true)
  }

  const create = useMutation({
    mutationFn: async () =>
      (
        await api.post<PurchaseOrderWire>('/purchase-orders', {
          supplier_id: supplierId,
          branch_id: branchId || undefined,
          tax: majorToMinor(tax) ?? undefined,
          shipping: majorToMinor(shipping) ?? undefined,
          notes: notes || undefined,
          lines: lines
            .filter((l) => l.part_id && Number(l.qty) > 0 && l.unit_cost !== '')
            .map((l) => ({
              part_id: l.part_id,
              qty_ordered: Number(l.qty),
              unit_cost: majorToMinor(l.unit_cost) ?? '0',
            })),
        })
      ).data,
    onSuccess: async () => {
      toast.success('Purchase order drafted')
      setDialogOpen(false)
      await invalidate()
    },
    onError: (e) => toast.error(apiErrorMessage(e)),
  })

  const lifecycle = useMutation({
    mutationFn: async ({ id, action }: { id: string; action: string }) =>
      api.post(`/purchase-orders/${id}/${action}`),
    onSuccess: async (_data, vars) => {
      const past: Record<string, string> = {
        submit: 'submitted',
        approve: 'approved',
        order: 'ordered',
        cancel: 'cancelled',
      }
      toast.success(`Purchase order ${past[vars.action] ?? 'updated'}`)
      await invalidate()
    },
    onError: (e) => toast.error(apiErrorMessage(e)),
  })

  function openReceive(po: PurchaseOrderWire) {
    setReceiveTarget(po)
    setDeliveryRef('')
    const init: Record<string, { qty: string; bin: string }> = {}
    for (const l of po.lines) {
      const outstanding = l.qty_ordered - l.qty_received
      init[l.id] = { qty: outstanding > 0 ? String(outstanding) : '0', bin: '' }
    }
    setReceiveLines(init)
  }

  const receive = useMutation({
    mutationFn: async () => {
      if (!receiveTarget) return
      return api.post(`/purchase-orders/${receiveTarget.id}/receipts`, {
        supplier_delivery_ref: deliveryRef || undefined,
        lines: receiveTarget.lines
          .map((l) => ({
            po_line_id: l.id,
            qty_received: Number(receiveLines[l.id]?.qty ?? '0'),
            bin_location: receiveLines[l.id]?.bin || undefined,
          }))
          .filter((l) => l.qty_received > 0),
      })
    },
    onSuccess: async () => {
      toast.success('Goods received')
      setReceiveTarget(null)
      await invalidate()
      await queryClient.invalidateQueries({ queryKey: ['inventory'] })
    },
    onError: (e) => toast.error(apiErrorMessage(e)),
  })

  const busy = create.isPending || lifecycle.isPending
  const validLines = lines.filter(
    (l) => l.part_id && Number(l.qty) > 0 && l.unit_cost !== '',
  )
  const canSubmit = supplierId !== '' && validLines.length > 0

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <Select
          value={status}
          onChange={(e) => {
            setStatus(e.target.value)
            setPage(1)
          }}
          className="w-48"
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
        {canCreate && <Button onClick={openCreate}>New purchase order</Button>}
      </div>

      {pos.isPending && (
        <p className="text-sm text-muted-foreground">Loading…</p>
      )}
      {pos.isError && (
        <p className="text-sm text-destructive">{apiErrorMessage(pos.error)}</p>
      )}
      {pos.data && (
        <div className="overflow-hidden rounded-xl border bg-card shadow-sm">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>PO</TableHead>
                <TableHead>Supplier</TableHead>
                <TableHead>Branch</TableHead>
                <TableHead className="text-right">Total</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Created</TableHead>
                {(canCreate || canReceive) && (
                  <TableHead className="w-56" />
                )}
              </TableRow>
            </TableHeader>
            <TableBody>
              {pos.data.data.length === 0 && (
                <TableRow>
                  <TableCell
                    colSpan={7}
                    className="text-center text-muted-foreground"
                  >
                    No purchase orders
                  </TableCell>
                </TableRow>
              )}
              {pos.data.data.map((po) => {
                const showOrder =
                  po.status === 'APPROVED' ||
                  (po.status === 'SUBMITTED' && !po.requires_approval)
                return (
                  <TableRow key={po.id}>
                    <TableCell className="font-mono text-sm">
                      {po.po_no}
                    </TableCell>
                    <TableCell>{po.supplier_name}</TableCell>
                    <TableCell>{po.branch_code}</TableCell>
                    <TableCell className="text-right">
                      {formatMoney(po.total, po.currency)}
                    </TableCell>
                    <TableCell>
                      <span className="inline-flex items-center gap-1">
                        {statusBadge(po.status)}
                        {po.status === 'SUBMITTED' && po.requires_approval && (
                          <Badge variant="warning">needs approval</Badge>
                        )}
                      </span>
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {formatDate(po.created_at)}
                    </TableCell>
                    {(canCreate || canReceive) && (
                      <TableCell>
                        <div className="flex flex-wrap gap-1">
                          {canReceive &&
                            (po.status === 'ORDERED' ||
                              po.status === 'PARTIALLY_RECEIVED') && (
                              <Button
                                variant="ghost"
                                size="sm"
                                disabled={busy}
                                onClick={() => openReceive(po)}
                              >
                                Receive
                              </Button>
                            )}
                          {canCreate && po.status === 'DRAFT' && (
                            <Button
                              variant="ghost"
                              size="sm"
                              disabled={busy}
                              onClick={() =>
                                lifecycle.mutate({ id: po.id, action: 'submit' })
                              }
                            >
                              Submit
                            </Button>
                          )}
                          {po.status === 'SUBMITTED' &&
                            po.requires_approval &&
                            canApprove && (
                              <Button
                                variant="ghost"
                                size="sm"
                                disabled={busy}
                                onClick={() =>
                                  lifecycle.mutate({
                                    id: po.id,
                                    action: 'approve',
                                  })
                                }
                              >
                                Approve
                              </Button>
                            )}
                          {canCreate && showOrder && (
                            <Button
                              variant="ghost"
                              size="sm"
                              disabled={busy}
                              onClick={() =>
                                lifecycle.mutate({ id: po.id, action: 'order' })
                              }
                            >
                              Order
                            </Button>
                          )}
                          {canCreate &&
                            po.status !== 'RECEIVED' &&
                            po.status !== 'CANCELLED' &&
                            po.status !== 'ORDERED' && (
                              <Button
                                variant="ghost"
                                size="sm"
                                disabled={busy}
                                onClick={() =>
                                  lifecycle.mutate({
                                    id: po.id,
                                    action: 'cancel',
                                  })
                                }
                              >
                                Cancel
                              </Button>
                            )}
                        </div>
                      </TableCell>
                    )}
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
          <div className="px-3 pb-3">
            <Pager
              page={pos.data.page}
              pageSize={pos.data.page_size}
              total={pos.data.total}
              onPageChange={setPage}
            />
          </div>
        </div>
      )}

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>New purchase order</DialogTitle>
            <DialogDescription>
              Draft an order to a supplier. Costs are entered in whole units of
              the supplier's currency.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <FormField label="Supplier" htmlFor="po-supplier">
                <Select
                  id="po-supplier"
                  value={supplierId}
                  onChange={(e) => setSupplierId(e.target.value)}
                >
                  <option value="">— select —</option>
                  {suppliers.data?.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name} ({s.default_currency})
                    </option>
                  ))}
                </Select>
              </FormField>
              <FormField
                label="Destination branch"
                htmlFor="po-branch"
                hint="Defaults to your branch"
              >
                <Select
                  id="po-branch"
                  value={branchId}
                  onChange={(e) => setBranchId(e.target.value)}
                >
                  <option value="">— your branch —</option>
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
                    className="w-16"
                    aria-label="Quantity"
                    placeholder="Qty"
                  />
                  <Input
                    inputMode="numeric"
                    value={line.unit_cost}
                    onChange={(e) =>
                      setLines((ls) =>
                        ls.map((l, j) =>
                          j === i ? { ...l, unit_cost: e.target.value } : l,
                        ),
                      )
                    }
                    className="w-24"
                    aria-label="Unit cost"
                    placeholder="Unit cost"
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
                    setLines((ls) => [
                      ...ls,
                      { part_id: '', qty: '1', unit_cost: '' },
                    ])
                  }
                >
                  Add line
                </Button>
              </div>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <FormField label="Tax" htmlFor="po-tax">
                <Input
                  id="po-tax"
                  inputMode="numeric"
                  value={tax}
                  onChange={(e) => setTax(e.target.value)}
                />
              </FormField>
              <FormField label="Shipping" htmlFor="po-shipping">
                <Input
                  id="po-shipping"
                  inputMode="numeric"
                  value={shipping}
                  onChange={(e) => setShipping(e.target.value)}
                />
              </FormField>
            </div>
            <FormField label="Notes (optional)" htmlFor="po-notes">
              <Input
                id="po-notes"
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

      <Dialog
        open={receiveTarget !== null}
        onOpenChange={(o) => !o && setReceiveTarget(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Receive {receiveTarget?.po_no}</DialogTitle>
            <DialogDescription>
              Enter the quantity received per line. This posts the stock into{' '}
              {receiveTarget?.branch_code} immediately.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-3">
            {receiveTarget?.lines.map((l) => {
              const outstanding = l.qty_ordered - l.qty_received
              return (
                <div key={l.id} className="flex items-center gap-2">
                  <div className="flex-1">
                    <div className="font-mono text-sm">
                      {l.part.part_number}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      ordered {l.qty_ordered} · received {l.qty_received} ·
                      outstanding {outstanding}
                    </div>
                  </div>
                  <Input
                    inputMode="numeric"
                    className="w-16"
                    aria-label="Qty received"
                    value={receiveLines[l.id]?.qty ?? '0'}
                    onChange={(e) =>
                      setReceiveLines((rl) => ({
                        ...rl,
                        [l.id]: { ...rl[l.id], qty: e.target.value },
                      }))
                    }
                  />
                  <Input
                    className="w-24"
                    aria-label="Bin"
                    placeholder="Bin"
                    value={receiveLines[l.id]?.bin ?? ''}
                    onChange={(e) =>
                      setReceiveLines((rl) => ({
                        ...rl,
                        [l.id]: { ...rl[l.id], bin: e.target.value },
                      }))
                    }
                  />
                </div>
              )
            })}
            <FormField label="Delivery reference (optional)" htmlFor="grn-ref">
              <Input
                id="grn-ref"
                value={deliveryRef}
                onChange={(e) => setDeliveryRef(e.target.value)}
                placeholder="Supplier waybill / delivery note"
              />
            </FormField>
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={() => setReceiveTarget(null)}
            >
              Cancel
            </Button>
            <Button
              disabled={receive.isPending}
              onClick={() => receive.mutate()}
            >
              {receive.isPending ? 'Receiving…' : 'Post receipt'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
