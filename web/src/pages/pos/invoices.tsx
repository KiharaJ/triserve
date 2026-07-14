import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useMemo, useState } from 'react'
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
import { FileText, Plus, Printer, Search } from 'lucide-react'
import { api, apiErrorMessage } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { useDebouncedValue } from '@/lib/use-debounced-value'
import { formatDate, formatMoney, majorToMinor, minorToMajor } from '@/lib/format'
import { Receipt } from '@/components/pos/receipt'
import { InvoiceDocument } from '@/components/pos/invoice-document'
import { JobPicker } from '@/components/shared/job-picker'
import { SearchPicker } from '@/components/shared/search-picker'
import { Textarea } from '@/components/ui/textarea'
import type {
  BranchWire,
  CompanyWire,
  CustomerWire,
  InvoiceStatus,
  InvoiceType,
  InvoiceWire,
  PartWire,
  PaymentMethodType,
  ProductWire,
  TaxRateWire,
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
  line_type: 'PART' | 'PRODUCT' | 'SERVICE' | 'CUSTOM'
  part_id: string
  /** For PRODUCT lines: the catalogue product picked (drives price + warranty). */
  product_id: string
  description: string
  qty: string
  unit_price: string
}

const EMPTY_LINE: DraftLine = {
  line_type: 'CUSTOM',
  part_id: '',
  product_id: '',
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
  // List filters.
  const [statusFilter, setStatusFilter] = useState('')
  const [typeFilter, setTypeFilter] = useState('')
  const [branchFilter, setBranchFilter] = useState('')
  const [searchInput, setSearchInput] = useState('')
  const search = useDebouncedValue(searchInput.trim(), 350)

  // New-invoice form.
  const [dialogOpen, setDialogOpen] = useState(false)
  const [type, setType] = useState<InvoiceType>('PARTS_SALE')
  const [branchId, setBranchId] = useState('')
  const [discount, setDiscount] = useState('')
  const [taxRateId, setTaxRateId] = useState('')
  const [notes, setNotes] = useState('')
  const [customerId, setCustomerId] = useState('')
  const [customerLabel, setCustomerLabel] = useState<string | null>(null)
  const [jobId, setJobId] = useState('')
  const [jobLabel, setJobLabel] = useState<string | null>(null)
  const [lines, setLines] = useState<DraftLine[]>([{ ...EMPTY_LINE }])

  // Full-invoice document view.
  const [viewTarget, setViewTarget] = useState<InvoiceWire | null>(null)

  const canCreate = can('invoice.create')
  const canVoid = can('invoice.void')
  const canPay = can('payment.capture')
  const isGroup = user?.scope === 'group'

  // Payment dialog state.
  const [payTarget, setPayTarget] = useState<InvoiceWire | null>(null)
  const [payMethod, setPayMethod] = useState<PaymentMethodType>('CASH')
  const [payAmount, setPayAmount] = useState('')
  const [payRef, setPayRef] = useState('')

  // Receipt preview/print state (fetched only when a receipt is opened).
  const [receiptTarget, setReceiptTarget] = useState<InvoiceWire | null>(null)
  const showDetail = !!receiptTarget || !!viewTarget
  const company = useQuery({
    queryKey: ['company'],
    enabled: showDetail,
    queryFn: async () => (await api.get<CompanyWire>('/company')).data,
  })
  const detailBranches = useQuery({
    queryKey: ['branches', 'detail'],
    enabled: showDetail,
    queryFn: async () =>
      (
        await api.get<PaginatedResponse<BranchWire>>('/branches', {
          params: { page_size: 100 },
        })
      ).data.data,
  })

  const branches = useQuery({
    queryKey: ['branches', 'all'],
    enabled: isGroup,
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

  const products = useQuery({
    queryKey: ['products', 'options'],
    enabled: canCreate,
    queryFn: async () =>
      (
        await api.get<PaginatedResponse<ProductWire>>('/products', {
          params: { page_size: 100, active: true },
        })
      ).data.data,
  })

  // VAT / tax rates are a configurable setting (Configuration → Tax rates).
  const taxRates = useQuery({
    queryKey: ['tax-rates', 'active'],
    enabled: canCreate,
    queryFn: async () =>
      (await api.get<PaginatedResponse<TaxRateWire>>('/tax-rates/active')).data
        .data,
  })

  const invoices = useQuery({
    queryKey: ['invoices', page, statusFilter, typeFilter, branchFilter, search],
    queryFn: async () =>
      (
        await api.get<PaginatedResponse<InvoiceWire>>('/invoices', {
          params: {
            page,
            page_size: 20,
            ...(statusFilter ? { status: statusFilter } : {}),
            ...(typeFilter ? { type: typeFilter } : {}),
            ...(branchFilter ? { branch_id: branchFilter } : {}),
            ...(search ? { q: search } : {}),
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
    setTaxRateId('')
    setNotes('')
    setCustomerId('')
    setCustomerLabel(null)
    setJobId('')
    setJobLabel(null)
    setLines([{ ...EMPTY_LINE }])
    setDialogOpen(true)
  }

  const create = useMutation({
    mutationFn: async () => {
      const invoice = (
        await api.post<InvoiceWire>('/invoices', {
          type,
          branch_id: branchId || undefined,
          customer_id: customerId || undefined,
          job_id: jobId || undefined,
          notes: notes.trim() || undefined,
          discount: majorToMinor(discount) ?? undefined,
          tax: totals.tax > 0 ? majorToMinor(String(totals.tax)) : undefined,
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
      ).data

      // Auto-register warranties for sold products that carry a default one.
      const today = new Date().toISOString().slice(0, 10)
      let registered = 0
      for (const l of lines) {
        if (l.line_type !== 'PRODUCT' || !l.product_id) continue
        const p = products.data?.find((x) => x.id === l.product_id)
        if (!p?.default_warranty_months) continue
        await api.post('/warranty-registrations', {
          product_name: p.name,
          brand: p.brand || undefined,
          kind: p.default_warranty_kind ?? 'STORE',
          start_date: today,
          months: p.default_warranty_months,
          branch_id: invoice.branch_id,
          invoice_id: invoice.id,
          customer_id: invoice.customer_id ?? undefined,
        })
        registered++
      }
      return { invoice, registered }
    },
    onSuccess: async ({ registered }) => {
      toast.success(
        registered > 0
          ? `Invoice created · ${registered} warranty${registered === 1 ? '' : 's'} registered`
          : 'Invoice created',
      )
      setDialogOpen(false)
      await invalidate()
    },
    onError: (e) => toast.error(apiErrorMessage(e)),
  })

  // Create a customer inline from the invoice form and attach it.
  const createCustomer = useMutation({
    mutationFn: async (name: string) => {
      const phone =
        window.prompt(`Add customer "${name}"\n\nPhone number (optional):`)?.trim() ||
        undefined
      return (await api.post<CustomerWire>('/customers', { name, phone })).data
    },
    onSuccess: (c) => {
      setCustomerId(c.id)
      setCustomerLabel(`${c.name}${c.phone ? ` · ${c.phone}` : ''}`)
      toast.success(`Customer ${c.name} added`)
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

  // Reset to page 1 whenever a filter or the search term changes.
  useEffect(() => {
    setPage(1)
  }, [statusFilter, typeFilter, branchFilter, search])

  const validLines = lines.filter(
    (l) => l.description && Number(l.qty) > 0 && l.unit_price,
  )

  // Live totals preview for the draft (whole-shilling arithmetic). VAT is
  // derived from the selected tax rate: tax = (subtotal − discount) × percent.
  const totals = useMemo(() => {
    const subtotal = validLines.reduce(
      (s, l) => s + Number(l.qty) * Number(l.unit_price),
      0,
    )
    const disc = Number(discount) || 0
    const rate = taxRates.data?.find((r) => r.id === taxRateId)
    const percent = rate ? Number(rate.percent) : 0
    const taxable = Math.max(0, subtotal - disc)
    const tax = Math.round((taxable * percent) / 100)
    return { subtotal, discount: disc, tax, percent, total: subtotal - disc + tax }
  }, [validLines, discount, taxRateId, taxRates.data])

  const fmtTsh = (n: number) => `TSh ${Math.round(n).toLocaleString()}`

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-48 flex-1 sm:max-w-xs">
          <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Search invoice #…"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            className="pl-7"
            aria-label="Search invoices"
          />
        </div>
        <Select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          className="w-36"
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
          value={typeFilter}
          onChange={(e) => setTypeFilter(e.target.value)}
          className="w-36"
          aria-label="Filter by type"
        >
          <option value="">All types</option>
          {TYPES.map((t) => (
            <option key={t} value={t}>
              {TYPE_STYLES[t].label}
            </option>
          ))}
        </Select>
        {isGroup && branches.data && branches.data.length > 0 && (
          <Select
            value={branchFilter}
            onChange={(e) => setBranchFilter(e.target.value)}
            className="w-36"
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
        <div className="flex-1" />
        {canCreate && (
          <Button onClick={openCreate} className="gap-1.5">
            <Plus className="size-4" /> New invoice
          </Button>
        )}
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
        <div className="overflow-hidden rounded-xl border bg-card shadow-sm">
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
                <TableHead className="w-56" />
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
                    <button
                      type="button"
                      className="font-medium text-primary hover:underline"
                      onClick={() => setViewTarget(inv)}
                    >
                      {inv.invoice_no}
                    </button>
                  </TableCell>
                  <TableCell>
                    {inv.customer_name ? (
                      <div className="flex flex-col gap-0.5">
                        <span className="font-medium">{inv.customer_name}</span>
                        <span>
                          <Badge
                            variant={inv.customer_is_dealer ? 'secondary' : 'outline'}
                            className="text-[10px]"
                          >
                            {inv.customer_is_dealer ? 'Dealer' : 'Retail'}
                          </Badge>
                        </span>
                      </div>
                    ) : (
                      <Badge variant="outline" className="text-muted-foreground">
                        Walk-in
                      </Badge>
                    )}
                  </TableCell>
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
                  <TableCell>
                    <div className="flex justify-end gap-1">
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
                      <Button
                        variant="ghost"
                        size="sm"
                        className="gap-1.5"
                        onClick={() => setViewTarget(inv)}
                        title="View invoice"
                      >
                        <FileText className="size-4" />
                        View
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="gap-1.5"
                        onClick={() => setReceiptTarget(inv)}
                        title="View / print receipt"
                      >
                        <Printer className="size-4" />
                        Receipt
                      </Button>
                    </div>
                  </TableCell>
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
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>New invoice</DialogTitle>
            <DialogDescription>
              Attach a job card or a customer, add lines, then create. Amounts
              are in whole shillings; payments are recorded afterwards.
            </DialogDescription>
          </DialogHeader>
          <div className="flex max-h-[70vh] flex-col gap-4 overflow-y-auto pr-1">
            <div className="grid gap-4 sm:grid-cols-2">
              <FormField label="Type" htmlFor="inv-type">
                <Select
                  id="inv-type"
                  value={type}
                  onChange={(e) => setType(e.target.value as InvoiceType)}
                >
                  {TYPES.map((t) => (
                    <option key={t} value={t}>
                      {TYPE_STYLES[t].label}
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

            <div className="grid gap-4 sm:grid-cols-2">
              <FormField
                label="Job card"
                htmlFor="inv-job"
                hint="Invoice a repair — filter by engineer, then pick the job"
              >
                <JobPicker
                  selectedLabel={jobLabel}
                  onSelect={(j) => {
                    setJobId(j.id)
                    setJobLabel(j.job_no)
                    setType('REPAIR_OW')
                    setCustomerId(j.customer_id)
                    setCustomerLabel(`Linked to ${j.job_no}`)
                  }}
                  onClear={() => {
                    setJobId('')
                    setJobLabel(null)
                  }}
                />
              </FormField>
              <FormField
                label="Customer"
                htmlFor="inv-customer"
                hint="Walk-in if left blank"
              >
                <SearchPicker<CustomerWire>
                  placeholder="Search name / phone…"
                  queryKey="invoice-customer-search"
                  selectedLabel={customerLabel}
                  queryFn={async (q) =>
                    (
                      await api.get<PaginatedResponse<CustomerWire>>('/customers', {
                        params: { q, page_size: 8 },
                      })
                    ).data.data
                  }
                  getKey={(c) => c.id}
                  renderItem={(c) => (
                    <>
                      <span className="font-medium">{c.name}</span>
                      {c.phone && (
                        <span className="text-xs text-muted-foreground">
                          {c.phone}
                        </span>
                      )}
                    </>
                  )}
                  onSelect={(c) => {
                    setCustomerId(c.id)
                    setCustomerLabel(`${c.name}${c.phone ? ` · ${c.phone}` : ''}`)
                  }}
                  onClear={() => {
                    setCustomerId('')
                    setCustomerLabel(null)
                  }}
                  onCreateNew={
                    can('customer.create')
                      ? (q) => createCustomer.mutate(q)
                      : undefined
                  }
                />
              </FormField>
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
                    <option value="PRODUCT">Product</option>
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
                  ) : line.line_type === 'PRODUCT' ? (
                    <Select
                      value={line.product_id}
                      onChange={(e) =>
                        setLines((ls) =>
                          ls.map((l, j) => {
                            if (j !== i) return l
                            const p = products.data?.find(
                              (x) => x.id === e.target.value,
                            )
                            return {
                              ...l,
                              product_id: e.target.value,
                              description: p ? p.name : l.description,
                              unit_price: p?.sell_price_tzs
                                ? minorToMajor(p.sell_price_tzs)
                                : l.unit_price,
                            }
                          }),
                        )
                      }
                      className="min-w-40 flex-1"
                      aria-label="Product"
                    >
                      <option value="">— product —</option>
                      {products.data?.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name}
                          {p.brand ? ` · ${p.brand}` : ''}
                          {p.default_warranty_months
                            ? ` (${p.default_warranty_months}mo warranty)`
                            : ''}
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

            <FormField label="Notes (optional)" htmlFor="inv-notes">
              <Textarea
                id="inv-notes"
                rows={2}
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="Note shown on the invoice…"
              />
            </FormField>

            <div className="grid gap-4 sm:grid-cols-2">
              <FormField label="Discount (TSh)" htmlFor="inv-discount">
                <Input
                  id="inv-discount"
                  inputMode="numeric"
                  value={discount}
                  onChange={(e) => setDiscount(e.target.value)}
                />
              </FormField>
              <FormField
                label="VAT"
                htmlFor="inv-vat"
                hint="Auto-calculated from the selected rate"
              >
                <Select
                  id="inv-vat"
                  value={taxRateId}
                  onChange={(e) => setTaxRateId(e.target.value)}
                >
                  <option value="">No VAT</option>
                  {taxRates.data?.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.label} ({r.percent}%)
                    </option>
                  ))}
                </Select>
              </FormField>
            </div>

            <div className="ml-auto w-full max-w-xs space-y-1 rounded-lg border bg-muted/30 p-3 text-sm">
              <div className="flex justify-between text-muted-foreground">
                <span>Subtotal</span>
                <span>{fmtTsh(totals.subtotal)}</span>
              </div>
              {totals.discount > 0 && (
                <div className="flex justify-between text-muted-foreground">
                  <span>Discount</span>
                  <span>- {fmtTsh(totals.discount)}</span>
                </div>
              )}
              {totals.tax > 0 && (
                <div className="flex justify-between text-muted-foreground">
                  <span>VAT ({totals.percent}%)</span>
                  <span>{fmtTsh(totals.tax)}</span>
                </div>
              )}
              <div className="flex justify-between border-t pt-1 text-base font-bold">
                <span>Total</span>
                <span>{fmtTsh(totals.total)}</span>
              </div>
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

      <Dialog
        open={receiptTarget !== null}
        onOpenChange={(o) => !o && setReceiptTarget(null)}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Receipt — {receiptTarget?.invoice_no}</DialogTitle>
            <DialogDescription>
              Preview below. Print sends only the receipt to your printer.
            </DialogDescription>
          </DialogHeader>
          <div className="max-h-[60vh] overflow-y-auto rounded-lg border bg-white p-3">
            {receiptTarget && (
              <Receipt
                invoice={receiptTarget}
                company={company.data}
                branch={detailBranches.data?.find(
                  (b) => b.id === receiptTarget.branch_id,
                )}
              />
            )}
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={() => setReceiptTarget(null)}
            >
              Close
            </Button>
            <Button className="gap-1.5" onClick={() => window.print()}>
              <Printer className="size-4" />
              Print
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={viewTarget !== null}
        onOpenChange={(o) => !o && setViewTarget(null)}
      >
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>Invoice {viewTarget?.invoice_no}</DialogTitle>
            <DialogDescription>
              Full invoice document — print or record a payment.
            </DialogDescription>
          </DialogHeader>
          <div className="max-h-[70vh] overflow-y-auto rounded-lg border bg-white">
            {viewTarget && (
              <InvoiceDocument
                invoice={viewTarget}
                company={company.data}
                branch={detailBranches.data?.find(
                  (b) => b.id === viewTarget.branch_id,
                )}
              />
            )}
          </div>
          <DialogFooter className="sm:justify-between">
            <Button
              type="button"
              variant="ghost"
              onClick={() => setViewTarget(null)}
            >
              Close
            </Button>
            <div className="flex gap-2">
              {viewTarget &&
                canPay &&
                (viewTarget.status === 'DRAFT' ||
                  viewTarget.status === 'PARTIAL') && (
                  <Button
                    variant="outline"
                    onClick={() => {
                      const t = viewTarget
                      setViewTarget(null)
                      openPay(t)
                    }}
                  >
                    Record payment
                  </Button>
                )}
              <Button className="gap-1.5" onClick={() => window.print()}>
                <Printer className="size-4" />
                Print
              </Button>
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
