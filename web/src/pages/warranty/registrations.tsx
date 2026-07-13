import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Plus, Search, ShieldCheck } from 'lucide-react'
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
import { formatDate } from '@/lib/format'
import { useDebouncedValue } from '@/lib/use-debounced-value'
import type {
  WarrantyKind,
  WarrantyRegistrationStatus,
  WarrantyRegistrationWire,
} from '@/lib/types'

const KINDS: WarrantyKind[] = ['STORE', 'MANUFACTURER', 'SAMSUNG']
const KIND_LABEL: Record<WarrantyKind, string> = {
  STORE: 'Store',
  MANUFACTURER: 'Manufacturer',
  SAMSUNG: 'Samsung',
}
const STATUSES: WarrantyRegistrationStatus[] = ['ACTIVE', 'EXPIRED', 'VOID']

function statusBadge(status: WarrantyRegistrationStatus) {
  switch (status) {
    case 'ACTIVE':
      return <Badge variant="success">Active</Badge>
    case 'EXPIRED':
      return <Badge variant="warning">Expired</Badge>
    default:
      return <Badge variant="destructive">Void</Badge>
  }
}

function kindBadge(kind: WarrantyKind) {
  const cls =
    kind === 'STORE'
      ? 'bg-indigo-500/15 text-indigo-700 ring-indigo-500/25 dark:text-indigo-400'
      : kind === 'SAMSUNG'
        ? 'bg-blue-500/15 text-blue-700 ring-blue-500/25 dark:text-blue-400'
        : 'bg-teal-500/15 text-teal-700 ring-teal-500/25 dark:text-teal-400'
  return <Badge className={`border-transparent ${cls}`}>{KIND_LABEL[kind]}</Badge>
}

/**
 * Warranty registrations (retail) — coverage the shop issues when it SELLS an
 * electronic product (any brand). Distinct from Samsung IW claims; a later
 * repair can look a serial up here to see if it's covered.
 */
export function WarrantyRegistrationsPage() {
  const { can } = useAuth()
  const queryClient = useQueryClient()
  const [page, setPage] = useState(1)
  const [statusFilter, setStatusFilter] = useState('')
  const [search, setSearch] = useState('')
  const debouncedSearch = useDebouncedValue(search, 350)

  const [dialogOpen, setDialogOpen] = useState(false)
  const [form, setForm] = useState({
    product_name: '',
    brand: '',
    kind: 'STORE' as WarrantyKind,
    start_date: '',
    months: '12',
    serial_no: '',
    terms: '',
  })

  const canCreate = can('invoice.create')

  const registrations = useQuery({
    queryKey: ['warranty-registrations', page, statusFilter, debouncedSearch],
    queryFn: async () =>
      (
        await api.get<PaginatedResponse<WarrantyRegistrationWire>>(
          '/warranty-registrations',
          {
            params: {
              page,
              page_size: 20,
              ...(statusFilter ? { status: statusFilter } : {}),
              ...(debouncedSearch ? { q: debouncedSearch } : {}),
            },
          },
        )
      ).data,
  })

  const invalidate = async () =>
    queryClient.invalidateQueries({ queryKey: ['warranty-registrations'] })

  function openCreate() {
    setForm({
      product_name: '',
      brand: '',
      kind: 'STORE',
      start_date: new Date().toISOString().slice(0, 10),
      months: '12',
      serial_no: '',
      terms: '',
    })
    setDialogOpen(true)
  }

  const create = useMutation({
    mutationFn: async () => {
      if (!form.product_name.trim()) throw new Error('Enter a product name')
      if (!form.start_date) throw new Error('Enter a start date')
      return (
        await api.post<WarrantyRegistrationWire>('/warranty-registrations', {
          product_name: form.product_name,
          brand: form.brand || undefined,
          kind: form.kind,
          start_date: form.start_date,
          months: Number(form.months) || undefined,
          serial_no: form.serial_no || undefined,
          terms: form.terms || undefined,
        })
      ).data
    },
    onSuccess: async () => {
      toast.success('Warranty registered')
      setDialogOpen(false)
      await invalidate()
    },
    onError: (e) =>
      toast.error(e instanceof Error ? e.message : apiErrorMessage(e)),
  })

  const voidReg = useMutation({
    mutationFn: async (id: string) =>
      (
        await api.patch<WarrantyRegistrationWire>(
          `/warranty-registrations/${id}`,
          { status: 'VOID' },
        )
      ).data,
    onSuccess: async () => {
      toast.success('Warranty voided')
      await invalidate()
    },
    onError: (e) => toast.error(apiErrorMessage(e)),
  })

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative w-64">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Search product, brand or serial…"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value)
              setPage(1)
            }}
            className="pl-8"
          />
        </div>
        <Select
          value={statusFilter}
          onChange={(e) => {
            setStatusFilter(e.target.value)
            setPage(1)
          }}
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
        <div className="flex-1" />
        {canCreate && (
          <Button onClick={openCreate} className="gap-1.5">
            <Plus className="size-4" /> Register warranty
          </Button>
        )}
      </div>

      {registrations.isPending && (
        <p className="text-sm text-muted-foreground">Loading…</p>
      )}
      {registrations.isError && (
        <p className="text-sm text-destructive">{apiErrorMessage(registrations.error)}</p>
      )}
      {registrations.data && (
        <div className="overflow-hidden rounded-xl border bg-card shadow-sm">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Product</TableHead>
                <TableHead>Serial</TableHead>
                <TableHead>Coverage</TableHead>
                <TableHead>Start</TableHead>
                <TableHead>Expiry</TableHead>
                <TableHead>Status</TableHead>
                {canCreate && <TableHead />}
              </TableRow>
            </TableHeader>
            <TableBody>
              {registrations.data.data.length === 0 && (
                <TableRow>
                  <TableCell colSpan={7} className="py-10 text-center text-muted-foreground">
                    No warranties registered yet.
                  </TableCell>
                </TableRow>
              )}
              {registrations.data.data.map((r) => (
                <TableRow key={r.id}>
                  <TableCell>
                    <div className="flex items-center gap-2.5">
                      <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-indigo-500/15 text-indigo-600 dark:text-indigo-400">
                        <ShieldCheck className="size-4" />
                      </span>
                      <div className="flex flex-col">
                        <span className="font-medium">{r.product_name}</span>
                        {r.brand && (
                          <span className="text-xs text-muted-foreground">{r.brand}</span>
                        )}
                      </div>
                    </div>
                  </TableCell>
                  <TableCell className="font-mono text-xs">{r.serial_no ?? '—'}</TableCell>
                  <TableCell>{kindBadge(r.kind)}</TableCell>
                  <TableCell className="text-muted-foreground">{formatDate(r.start_date)}</TableCell>
                  <TableCell className="text-muted-foreground">{formatDate(r.expiry_date)}</TableCell>
                  <TableCell>{statusBadge(r.status)}</TableCell>
                  {canCreate && (
                    <TableCell className="text-right">
                      {r.status !== 'VOID' && (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => {
                            if (window.confirm('Void this warranty?')) voidReg.mutate(r.id)
                          }}
                        >
                          Void
                        </Button>
                      )}
                    </TableCell>
                  )}
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <div className="border-t px-4 py-3">
            <Pager
              page={registrations.data.page}
              pageSize={registrations.data.page_size}
              total={registrations.data.total}
              onPageChange={setPage}
            />
          </div>
        </div>
      )}

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Register warranty</DialogTitle>
          </DialogHeader>
          <div className="flex flex-col gap-3">
            <FormField label="Product">
              <Input
                value={form.product_name}
                onChange={(e) => setForm((f) => ({ ...f, product_name: e.target.value }))}
                placeholder='e.g. Hisense 55" 4K TV'
              />
            </FormField>
            <div className="grid gap-3 sm:grid-cols-2">
              <FormField label="Brand">
                <Input
                  value={form.brand}
                  onChange={(e) => setForm((f) => ({ ...f, brand: e.target.value }))}
                  placeholder="Any brand"
                />
              </FormField>
              <FormField label="Coverage">
                <Select
                  value={form.kind}
                  onChange={(e) => setForm((f) => ({ ...f, kind: e.target.value as WarrantyKind }))}
                >
                  {KINDS.map((k) => (
                    <option key={k} value={k}>
                      {KIND_LABEL[k]}
                    </option>
                  ))}
                </Select>
              </FormField>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <FormField label="Start date">
                <Input
                  type="date"
                  value={form.start_date}
                  onChange={(e) => setForm((f) => ({ ...f, start_date: e.target.value }))}
                />
              </FormField>
              <FormField label="Duration (months)">
                <Input
                  inputMode="numeric"
                  value={form.months}
                  onChange={(e) => setForm((f) => ({ ...f, months: e.target.value }))}
                />
              </FormField>
            </div>
            <FormField label="Serial / IMEI (optional)">
              <Input
                value={form.serial_no}
                onChange={(e) => setForm((f) => ({ ...f, serial_no: e.target.value }))}
                placeholder="For point-of-repair lookup"
              />
            </FormField>
            <FormField label="Terms (optional)">
              <Textarea
                rows={2}
                value={form.terms}
                onChange={(e) => setForm((f) => ({ ...f, terms: e.target.value }))}
              />
            </FormField>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)}>
              Cancel
            </Button>
            <Button onClick={() => create.mutate()} disabled={create.isPending}>
              Register
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
