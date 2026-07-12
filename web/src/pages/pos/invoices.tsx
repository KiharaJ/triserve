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
import { formatDate, formatMoney, majorToMinor, minorToMajor } from '@/lib/format'
import type {
  BranchWire,
  InvoiceStatus,
  InvoiceType,
  InvoiceWire,
  PartWire,
  PaymentMethodType,
} from '@/lib/types'

const PAYMENT_METHODS: PaymentMethodType[] = [
  'CASH',
  'MPESA',
  'TIGOPESA',
  'AIRTEL',
  'CARD',
  'BANK',
]

const TYPES: InvoiceType[] = [
  'REPAIR_OW',
  'PARTS_SALE',
  'PRODUCT_SALE',
  'ACCESSORY',
]
const STATUSES: InvoiceStatus[] = [
  'DRAFT',
  'PARTIAL',
  'PAID',
  'VOID',
  'REFUNDED',
]

function statusBadge(status: InvoiceStatus) {
  switch (status) {
    case 'DRAFT':
      return <Badge variant="secondary">Draft</Badge>
    case 'PARTIAL':
      return <Badge variant="warning">Part-paid</Badge>
    case 'PAID':
      return <Badge variant="success">Paid</Badge>
    case 'REFUNDED':
      return <Badge variant="warning">Refunded</Badge>
    default:
      return <Badge variant="destructive">Void</Badge>
  }
}

const TYPE_STYLES: Record<InvoiceType, { label: string; cls: string }> = {
  REPAIR_OW: {
    label: 'Repair',
    cls: 'bg-sky-500/15 text-sky-700 ring-sky-500/25 dark:text-sky-400',
  },
  PARTS_SALE: {
    label: 'Parts',
    cls: 'bg-violet-500/15 text-violet-700 ring-violet-500/25 dark:text-violet-400',
  },
  PRODUCT_SALE: {
    label: 'Product',
    cls: 'bg-emerald-500/15 text-emerald-700 ring-emerald-500/25 dark:text-emerald-400',
  },
  ACCESSORY: {
    label: 'Accessory',
    cls: 'bg-amber-500/15 text-amber-700 ring-amber-500/25 dark:text-amber-400',
  },
}

function typeBadge(type: InvoiceType) {
  const t = TYPE_STYLES[type]
  return <Badge className={`border-transparent ${t.cls}`}>{t.label}</Badge>
}

interface DraftLine {
  line_type: 'PART' | 'SERVICE' | 'CUSTOM'
  part_id: string
  description: string
  qty: string
  unit_price: string
}

const EMPTY_LINE: DraftLine = {
  line_type: 'CUSTOM',
  part_id: '',
  description: '',
  qty: '1',
  unit_price: '',
}

/**
 * POS invoices (Task 3.1, §4.6): draft an OW sale (repair / parts / accessory /
 * product) with line items and computed totals. Payments + receipts (Task 3.2)
 * and accounting posting (Task 3.3) build on this.
 */
export function InvoicesPage() {
  const { can, user } = useAuth()
  const queryClient = useQueryClient()
  const [page, setPage] = useState(1)
  const [statusFilter, setStatusFilter] = useState('')
  const [dialogOpen, setDialogOpen] = useState(false)
  const [type, setType] = useState<InvoiceType>('PARTS_SALE')
  const [branchId, setBranchId] = useState('')
  const [discount, setDiscount] = useState('')
  const [tax, setTax] = useState('')
  const [lines, setLines] = useState<DraftLine[]>([{ ...EMPTY_LINE }])

  const canCreate = can('invoice.create')
  const canVoid = can('invoice.void')
  const canPay = can('payment.capture')
  const isGroup = user?.scope === 'group'

  // Payment dialog state.
  const [payTarget, setPayTarget] = useState<InvoiceWire | null>(null)
  const [payMethod, setPayMethod] = useState<PaymentMethodType>('CASH')
  const [payAmount, setPayAmount] = useState('')
  const [payRef, setPayRef] = useState('')

  const branches = useQuery({
    queryKey: ['branches', 'all'],
    enabled: canCreate && isGroup,
    queryFn: async () =>
      (
        await api.get<PaginatedResponse<BranchWire>>('/branches', {
          params: { page_size: 100 },
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

  const invoices = useQuery({
    queryKey: ['invoices', page, statusFilter],
    queryFn: async () =>
      (
        await api.get<PaginatedResponse<InvoiceWire>>('/invoices', {
          params: {
            page,
            page_size: 20,
            ...(statusFilter ? { status: statusFilter } : {}),
          },
        })
      ).data,
  })

  const invalidate = async () =>
    queryClient.invalidateQueries({ queryKey: ['invoices'] })

  function openCreate() {
    setType('PARTS_SALE')
    setBranchId('')
    setDiscount('')
    setTax('')
    setLines([{ ...EMPTY_LINE }])
    setDialogOpen(true)
  }

  const create = useMutation({
    mutationFn: async () =>
      (
        await api.post<InvoiceWire>('/invoices', {
          type,
          branch_id: branchId || undefined,
          discount: majorToMinor(discount) ?? undefined,
          tax: majorToMinor(tax) ?? undefined,
          lines: lines
            .filter((l) => l.description && Number(l.qty) > 0 && l.unit_price)
            .map((l) => ({
              line_type: l.line_type,
              part_id: l.line_type === 'PART' ? l.part_id || undefined : undefined,
              description: l.description,
              qty: Number(l.qty),
              unit_price: majorToMinor(l.unit_price) ?? '0',
            })),
        })
      ).data,
    onSuccess: async () => {
      toast.success('Invoice created')
      setDialogOpen(false)
      await invalidate()
    },
    onError: (e) => toast.error(apiErrorMessage(e)),
  })

  const voidInvoice = useMutation({
    mutationFn: async (id: string) => {
      const reason = window.prompt('Reason for voiding this invoice?')
      if (!reason) throw new Error('cancelled')
      return (
        await api.post<{ held: boolean }>(`/invoices/${id}/void`, { reason })
      ).data
    },
    onSuccess: async (res) => {
      toast.success(res.held ? 'Void sent for approval' : 'Invoice voided')
      await invalidate()
    },
    onError: (e) => {
      if (e instanceof Error && e.message === 'cancelled') return
      toast.error(apiErrorMessage(e))
    },
  })

  function openPay(inv: InvoiceWire) {
    setPayTarget(inv)
    setPayMethod('CASH')
    setPayAmount(minorToMajor(inv.balance)) // default to the outstanding balance
    setPayRef('')
  }

  const recordPayment = useMutation({
    mutationFn: async () => {
      if (!payTarget) return
      return (
        await api.post<{ invoice: { status: string } }>(
          `/invoices/${payTarget.id}/payments`,
          {
            method: payMethod,
            amount: majorToMinor(payAmount) ?? '0',
            reference: payRef || undefined,
          },
        )
      ).data
    },
    onSuccess: async (res) => {
      toast.success(
        res?.invoice.status === 'PAID' ? 'Invoice fully paid' : 'Payment recorded',
      )
      setPayTarget(null)
      await invalidate()
    },
    onError: (e) => toast.error(apiErrorMessage(e)),
  })

  const validLines = lines.filter(
    (l) => l.description && Number(l.qty) > 0 && l.unit_price,
  )

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
        {canCreate && <Button onClick={openCreate}>New invoice</Button>}
      </div>

      {invoices.isPending && (
        <p className="text-sm text-muted-foreground">Loading…</p>
      )}
      {invoices.isError && (
        <p className="text-sm text-destructive">
          {apiErrorMessage(invoices.error)}
        </p>
      )}
      {invoices.data && (
        <div className="rounded-xl border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Invoice</TableHead>
                <TableHead>Customer</TableHead>
                <TableHead>Type</TableHead>
                <TableHead className="text-right">Total</TableHead>
                <TableHead className="text-right">Balance</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Created</TableHead>
                {(canVoid || canPay) && <TableHead className="w-28" />}
              </TableRow>
            </TableHeader>
            <TableBody>
              {invoices.data.data.length === 0 && (
                <TableRow>
                  <TableCell
                    colSpan={8}
                    className="text-center text-muted-foreground"
                  >
                    No invoices
                  </TableCell>
                </TableRow>
              )}
              {invoices.data.data.map((inv) => (
                <TableRow key={inv.id}>
                  <TableCell className="font-mono text-sm">
                    {inv.invoice_no}
                  </TableCell>
                  <TableCell>{inv.customer_name ?? 'Walk-in'}</TableCell>
                  <TableCell>{typeBadge(inv.type)}</TableCell>
                  <TableCell className="text-right">
                    {formatMoney(inv.total, inv.currency)}
                  </TableCell>
                  <TableCell className="text-right">
                    {inv.status === 'PAID' || inv.status === 'VOID' ? (
                      <span className="text-muted-foreground">—</span>
                    ) : (
                      formatMoney(inv.balance, inv.currency)
                    )}
                  </TableCell>
                  <TableCell>{statusBadge(inv.status)}</TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {formatDate(inv.created_at)}
                  </TableCell>
                  {(canVoid || canPay) && (
                    <TableCell>
                      <div className="flex gap-1">
                        {canPay &&
                          (inv.status === 'DRAFT' ||
                            inv.status === 'PARTIAL') && (
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => openPay(inv)}
                            >
                              Pay
                            </Button>
                          )}
                        {canVoid &&
                          (inv.status === 'DRAFT' ||
                            inv.status === 'PARTIAL') && (
                            <Button
                              variant="ghost"
                              size="sm"
                              disabled={voidInvoice.isPending}
                              onClick={() => voidInvoice.mutate(inv.id)}
                            >
                              Void
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
              page={invoices.data.page}
              pageSize={invoices.data.page_size}
              total={invoices.data.total}
              onPageChange={setPage}
            />
          </div>
        </div>
      )}

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>New invoice</DialogTitle>
            <DialogDescription>
              Amounts are entered in whole shillings. Payments are recorded
              after the invoice is created.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <FormField label="Type" htmlFor="inv-type">
                <Select
                  id="inv-type"
                  value={type}
                  onChange={(e) => setType(e.target.value as InvoiceType)}
                >
                  {TYPES.map((t) => (
                    <option key={t} value={t}>
                      {t}
                    </option>
                  ))}
                </Select>
              </FormField>
              {isGroup && (
                <FormField label="Branch" htmlFor="inv-branch">
                  <Select
                    id="inv-branch"
                    value={branchId}
                    onChange={(e) => setBranchId(e.target.value)}
                  >
                    <option value="">— select a branch —</option>
                    {branches.data?.map((b) => (
                      <option key={b.id} value={b.id}>
                        {b.code} — {b.name}
                      </option>
                    ))}
                  </Select>
                </FormField>
              )}
            </div>

            <div className="flex flex-col gap-2">
              <span className="text-sm font-medium">Lines</span>
              {lines.map((line, i) => (
                <div key={i} className="flex flex-wrap items-center gap-2">
                  <Select
                    value={line.line_type}
                    onChange={(e) =>
                      setLines((ls) =>
                        ls.map((l, j) =>
                          j === i
                            ? {
                                ...l,
                                line_type: e.target.value as DraftLine['line_type'],
                              }
                            : l,
                        ),
                      )
                    }
                    className="w-28"
                    aria-label="Line type"
                  >
                    <option value="CUSTOM">Custom</option>
                    <option value="PART">Part</option>
                    <option value="SERVICE">Service</option>
                  </Select>
                  {line.line_type === 'PART' ? (
                    <Select
                      value={line.part_id}
                      onChange={(e) =>
                        setLines((ls) =>
                          ls.map((l, j) => {
                            if (j !== i) return l
                            const p = parts.data?.find(
                              (x) => x.id === e.target.value,
                            )
                            return {
                              ...l,
                              part_id: e.target.value,
                              description: p ? p.part_number : l.description,
                            }
                          }),
                        )
                      }
                      className="min-w-40 flex-1"
                      aria-label="Part"
                    >
                      <option value="">— part —</option>
                      {parts.data?.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.part_number} — {p.description}
                        </option>
                      ))}
                    </Select>
                  ) : (
                    <Input
                      value={line.description}
                      onChange={(e) =>
                        setLines((ls) =>
                          ls.map((l, j) =>
                            j === i ? { ...l, description: e.target.value } : l,
                          ),
                        )
                      }
                      className="min-w-40 flex-1"
                      placeholder="Description"
                      aria-label="Description"
                    />
                  )}
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
                    className="w-14"
                    placeholder="Qty"
                    aria-label="Quantity"
                  />
                  <Input
                    inputMode="numeric"
                    value={line.unit_price}
                    onChange={(e) =>
                      setLines((ls) =>
                        ls.map((l, j) =>
                          j === i ? { ...l, unit_price: e.target.value } : l,
                        ),
                      )
                    }
                    className="w-24"
                    placeholder="Price"
                    aria-label="Unit price"
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
                  onClick={() => setLines((ls) => [...ls, { ...EMPTY_LINE }])}
                >
                  Add line
                </Button>
              </div>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <FormField label="Discount" htmlFor="inv-discount">
                <Input
                  id="inv-discount"
                  inputMode="numeric"
                  value={discount}
                  onChange={(e) => setDiscount(e.target.value)}
                />
              </FormField>
              <FormField label="Tax" htmlFor="inv-tax">
                <Input
                  id="inv-tax"
                  inputMode="numeric"
                  value={tax}
                  onChange={(e) => setTax(e.target.value)}
                />
              </FormField>
            </div>
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
              disabled={
                create.isPending ||
                validLines.length === 0 ||
                (isGroup && !branchId)
              }
              onClick={() => create.mutate()}
            >
              {create.isPending ? 'Saving…' : 'Create invoice'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={payTarget !== null}
        onOpenChange={(o) => !o && setPayTarget(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Record payment — {payTarget?.invoice_no}</DialogTitle>
            <DialogDescription>
              Outstanding balance{' '}
              {payTarget &&
                formatMoney(payTarget.balance, payTarget.currency)}
              . Amount is in whole shillings.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <FormField label="Method" htmlFor="pay-method">
                <Select
                  id="pay-method"
                  value={payMethod}
                  onChange={(e) =>
                    setPayMethod(e.target.value as PaymentMethodType)
                  }
                >
                  {PAYMENT_METHODS.map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                </Select>
              </FormField>
              <FormField label="Amount" htmlFor="pay-amount">
                <Input
                  id="pay-amount"
                  inputMode="numeric"
                  value={payAmount}
                  onChange={(e) => setPayAmount(e.target.value)}
                />
              </FormField>
            </div>
            <FormField
              label="Reference (optional)"
              htmlFor="pay-ref"
              hint="M-Pesa code, card auth, bank ref…"
            >
              <Input
                id="pay-ref"
                value={payRef}
                onChange={(e) => setPayRef(e.target.value)}
              />
            </FormField>
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={() => setPayTarget(null)}
            >
              Cancel
            </Button>
            <Button
              disabled={recordPayment.isPending || !payAmount}
              onClick={() => recordPayment.mutate()}
            >
              {recordPayment.isPending ? 'Saving…' : 'Record payment'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
