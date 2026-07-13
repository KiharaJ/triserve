import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Package, Plus, Search } from 'lucide-react'
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
import { formatMoney, majorToMinor, minorToMajor } from '@/lib/format'
import { useDebouncedValue } from '@/lib/use-debounced-value'
import type { ProductWire, WarrantyKind } from '@/lib/types'

const TYPES = ['Mobile', 'Tablet', 'Watch', 'Laptop', 'TV', 'Fridge', 'AC', 'Two-Wheeler', 'Accessory', 'Other']
const KINDS: WarrantyKind[] = ['STORE', 'MANUFACTURER', 'SAMSUNG']

const EMPTY = {
  id: '',
  sku: '',
  name: '',
  brand: '',
  device_type: 'Mobile',
  sell_price: '',
  stock_qty: '0',
  warranty_months: '12',
  warranty_kind: 'STORE' as WarrantyKind,
}

/**
 * Products catalogue (retail) — the electronics the shop sells (any brand),
 * separate from Samsung repair spares. Each product can carry a default
 * warranty that a PRODUCT_SALE offers to register.
 */
export function ProductsPage() {
  const { can } = useAuth()
  const queryClient = useQueryClient()
  const [page, setPage] = useState(1)
  const [search, setSearch] = useState('')
  const debouncedSearch = useDebouncedValue(search, 350)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [form, setForm] = useState({ ...EMPTY })

  const canManage = can('part.manage')

  const products = useQuery({
    queryKey: ['products', page, debouncedSearch],
    queryFn: async () =>
      (
        await api.get<PaginatedResponse<ProductWire>>('/products', {
          params: { page, page_size: 20, ...(debouncedSearch ? { q: debouncedSearch } : {}) },
        })
      ).data,
  })

  const invalidate = async () =>
    queryClient.invalidateQueries({ queryKey: ['products'] })

  function openCreate() {
    setForm({ ...EMPTY })
    setDialogOpen(true)
  }
  function openEdit(p: ProductWire) {
    setForm({
      id: p.id,
      sku: p.sku,
      name: p.name,
      brand: p.brand,
      device_type: p.device_type ?? 'Mobile',
      sell_price: minorToMajor(p.sell_price_tzs),
      stock_qty: String(p.stock_qty),
      warranty_months: p.default_warranty_months !== null ? String(p.default_warranty_months) : '',
      warranty_kind: p.default_warranty_kind ?? 'STORE',
    })
    setDialogOpen(true)
  }

  const save = useMutation({
    mutationFn: async () => {
      if (!form.sku.trim() || !form.name.trim()) throw new Error('SKU and name are required')
      const payload = {
        name: form.name,
        brand: form.brand || undefined,
        device_type: form.device_type || undefined,
        sell_price_tzs: majorToMinor(form.sell_price) ?? undefined,
        stock_qty: Number(form.stock_qty) || 0,
        default_warranty_months: form.warranty_months ? Number(form.warranty_months) : undefined,
        default_warranty_kind: form.warranty_months ? form.warranty_kind : undefined,
      }
      if (form.id) {
        return (await api.patch<ProductWire>(`/products/${form.id}`, payload)).data
      }
      return (await api.post<ProductWire>('/products', { sku: form.sku, ...payload })).data
    },
    onSuccess: async () => {
      toast.success(form.id ? 'Product updated' : 'Product added')
      setDialogOpen(false)
      await invalidate()
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : apiErrorMessage(e)),
  })

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative w-72">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Search SKU, name, brand or type…"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value)
              setPage(1)
            }}
            className="pl-8"
          />
        </div>
        <div className="flex-1" />
        {canManage && (
          <Button onClick={openCreate} className="gap-1.5">
            <Plus className="size-4" /> Add product
          </Button>
        )}
      </div>

      {products.isPending && <p className="text-sm text-muted-foreground">Loading…</p>}
      {products.isError && (
        <p className="text-sm text-destructive">{apiErrorMessage(products.error)}</p>
      )}
      {products.data && (
        <div className="overflow-hidden rounded-xl border bg-card shadow-sm">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Product</TableHead>
                <TableHead>Type</TableHead>
                <TableHead className="text-right">Price</TableHead>
                <TableHead className="text-right">Stock</TableHead>
                <TableHead>Warranty</TableHead>
                {canManage && <TableHead />}
              </TableRow>
            </TableHeader>
            <TableBody>
              {products.data.data.length === 0 && (
                <TableRow>
                  <TableCell colSpan={6} className="py-10 text-center text-muted-foreground">
                    No products yet.
                  </TableCell>
                </TableRow>
              )}
              {products.data.data.map((p) => (
                <TableRow key={p.id}>
                  <TableCell>
                    <div className="flex items-center gap-2.5">
                      <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-violet-500/15 text-violet-600 dark:text-violet-400">
                        <Package className="size-4" />
                      </span>
                      <div className="flex flex-col">
                        <span className="font-medium">{p.name}</span>
                        <span className="font-mono text-xs text-muted-foreground">
                          {p.sku}
                          {p.brand ? ` · ${p.brand}` : ''}
                        </span>
                      </div>
                    </div>
                  </TableCell>
                  <TableCell>
                    {p.device_type ? <Badge variant="secondary">{p.device_type}</Badge> : '—'}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {p.sell_price_tzs ? formatMoney(p.sell_price_tzs) : '—'}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {p.stock_qty > 0 ? (
                      p.stock_qty
                    ) : (
                      <span className="text-rose-600 dark:text-rose-400">0</span>
                    )}
                  </TableCell>
                  <TableCell>
                    {p.default_warranty_months ? (
                      <Badge variant="info">
                        {p.default_warranty_months}mo · {p.default_warranty_kind}
                      </Badge>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </TableCell>
                  {canManage && (
                    <TableCell className="text-right">
                      <Button variant="ghost" size="sm" onClick={() => openEdit(p)}>
                        Edit
                      </Button>
                    </TableCell>
                  )}
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <div className="border-t px-4 py-3">
            <Pager
              page={products.data.page}
              pageSize={products.data.page_size}
              total={products.data.total}
              onPageChange={setPage}
            />
          </div>
        </div>
      )}

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{form.id ? 'Edit product' : 'Add product'}</DialogTitle>
          </DialogHeader>
          <div className="flex flex-col gap-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <FormField label="SKU">
                <Input
                  value={form.sku}
                  disabled={Boolean(form.id)}
                  onChange={(e) => setForm((f) => ({ ...f, sku: e.target.value }))}
                  placeholder="TV-HIS-55"
                />
              </FormField>
              <FormField label="Type">
                <Select
                  value={form.device_type}
                  onChange={(e) => setForm((f) => ({ ...f, device_type: e.target.value }))}
                >
                  {TYPES.map((t) => (
                    <option key={t} value={t}>
                      {t}
                    </option>
                  ))}
                </Select>
              </FormField>
            </div>
            <FormField label="Name">
              <Input
                value={form.name}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                placeholder='Hisense 55" 4K TV'
              />
            </FormField>
            <div className="grid gap-3 sm:grid-cols-3">
              <FormField label="Brand">
                <Input value={form.brand} onChange={(e) => setForm((f) => ({ ...f, brand: e.target.value }))} />
              </FormField>
              <FormField label="Price (TZS)">
                <Input
                  inputMode="numeric"
                  value={form.sell_price}
                  onChange={(e) => setForm((f) => ({ ...f, sell_price: e.target.value }))}
                />
              </FormField>
              <FormField label="Stock">
                <Input
                  inputMode="numeric"
                  value={form.stock_qty}
                  onChange={(e) => setForm((f) => ({ ...f, stock_qty: e.target.value }))}
                />
              </FormField>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <FormField label="Warranty (months)">
                <Input
                  inputMode="numeric"
                  value={form.warranty_months}
                  onChange={(e) => setForm((f) => ({ ...f, warranty_months: e.target.value }))}
                  placeholder="blank = none"
                />
              </FormField>
              <FormField label="Warranty type">
                <Select
                  value={form.warranty_kind}
                  onChange={(e) => setForm((f) => ({ ...f, warranty_kind: e.target.value as WarrantyKind }))}
                >
                  {KINDS.map((k) => (
                    <option key={k} value={k}>
                      {k}
                    </option>
                  ))}
                </Select>
              </FormField>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)}>
              Cancel
            </Button>
            <Button onClick={() => save.mutate()} disabled={save.isPending}>
              {form.id ? 'Save' : 'Add product'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
