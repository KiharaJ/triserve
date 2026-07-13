import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Plus, Search, Smartphone } from 'lucide-react'
import { useState } from 'react'
import { Link } from 'react-router-dom'
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
import { useDebouncedValue } from '@/lib/use-debounced-value'
import type { CustomerWire, DeviceWire } from '@/lib/types'

// Common retail types — free text is allowed on the API, these are quick picks.
const DEVICE_TYPES = [
  'Mobile',
  'Tablet',
  'Watch',
  'Laptop',
  'TV',
  'Fridge',
  'AC',
  'Two-Wheeler',
  'Other',
]

function typeBadge(type: string | null) {
  if (!type) return <span className="text-muted-foreground">—</span>
  return <Badge variant="secondary">{type}</Badge>
}

/**
 * Devices register (Phase 5 / E3) — a master list of every device on file, any
 * brand/type (Mobile, Watch, Laptop, TV, Two-Wheeler…). Search across type/
 * brand/model/serial/customer; add a device linked to a customer. Rows link to
 * the owning customer's 360.
 */
export function DevicesListPage() {
  const { can } = useAuth()
  const queryClient = useQueryClient()
  const [page, setPage] = useState(1)
  const [search, setSearch] = useState('')
  const [typeFilter, setTypeFilter] = useState('')
  const debouncedSearch = useDebouncedValue(search, 350)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [form, setForm] = useState({
    customer_id: '',
    device_type: 'Mobile',
    brand: '',
    model: '',
    imei_serial: '',
    color: '',
  })

  const canCreate = can('device.create')

  const devices = useQuery({
    queryKey: ['devices', page, debouncedSearch, typeFilter],
    queryFn: async () =>
      (
        await api.get<PaginatedResponse<DeviceWire>>('/devices', {
          params: {
            page,
            page_size: 20,
            ...(debouncedSearch ? { q: debouncedSearch } : {}),
            ...(typeFilter ? { type: typeFilter } : {}),
          },
        })
      ).data,
  })

  // Customer picker for the add dialog (recent 100; searchable via the API list).
  const customers = useQuery({
    queryKey: ['customers', 'options'],
    enabled: canCreate && dialogOpen,
    queryFn: async () =>
      (await api.get<PaginatedResponse<CustomerWire>>('/customers', { params: { page_size: 100 } }))
        .data.data,
  })

  const create = useMutation({
    mutationFn: async () => {
      if (!form.customer_id) throw new Error('Select a customer')
      if (!form.brand.trim()) throw new Error('Enter a brand')
      return (
        await api.post<DeviceWire>('/devices', {
          customer_id: form.customer_id,
          brand: form.brand,
          model: form.model || undefined,
          device_type: form.device_type || undefined,
          imei_serial: form.imei_serial || undefined,
          color: form.color || undefined,
        })
      ).data
    },
    onSuccess: async () => {
      toast.success('Device added')
      setDialogOpen(false)
      await queryClient.invalidateQueries({ queryKey: ['devices'] })
    },
    onError: (e) =>
      toast.error(e instanceof Error ? e.message : apiErrorMessage(e)),
  })

  function openCreate() {
    setForm({ customer_id: '', device_type: 'Mobile', brand: '', model: '', imei_serial: '', color: '' })
    setDialogOpen(true)
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative w-72">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Search type, brand, model, serial or owner…"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value)
              setPage(1)
            }}
            className="pl-8"
          />
        </div>
        <Select
          value={typeFilter}
          onChange={(e) => {
            setTypeFilter(e.target.value)
            setPage(1)
          }}
          className="w-40"
          aria-label="Filter by type"
        >
          <option value="">All types</option>
          {DEVICE_TYPES.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </Select>
        <div className="flex-1" />
        {canCreate && (
          <Button onClick={openCreate} className="gap-1.5">
            <Plus className="size-4" /> Add device
          </Button>
        )}
      </div>

      {devices.isPending && <p className="text-sm text-muted-foreground">Loading…</p>}
      {devices.isError && (
        <p className="text-sm text-destructive">{apiErrorMessage(devices.error)}</p>
      )}
      {devices.data && (
        <div className="overflow-hidden rounded-xl border bg-card shadow-sm">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Type</TableHead>
                <TableHead>Brand</TableHead>
                <TableHead>Model</TableHead>
                <TableHead>Serial / IMEI</TableHead>
                <TableHead>Customer</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {devices.data.data.length === 0 && (
                <TableRow>
                  <TableCell colSpan={5} className="py-10 text-center text-muted-foreground">
                    No devices found.
                  </TableCell>
                </TableRow>
              )}
              {devices.data.data.map((d) => (
                <TableRow key={d.id}>
                  <TableCell>
                    <div className="flex items-center gap-2.5">
                      <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-teal-500/15 text-teal-600 dark:text-teal-400">
                        <Smartphone className="size-4" />
                      </span>
                      {typeBadge(d.device_type)}
                    </div>
                  </TableCell>
                  <TableCell className="font-medium">{d.brand}</TableCell>
                  <TableCell className="text-muted-foreground">{d.model ?? '—'}</TableCell>
                  <TableCell className="font-mono text-xs">{d.imei_serial ?? '—'}</TableCell>
                  <TableCell>
                    {d.customer_name ? (
                      <Link to={`/customers/${d.customer_id}`} className="hover:underline">
                        {d.customer_name}
                      </Link>
                    ) : (
                      '—'
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <div className="border-t px-4 py-3">
            <Pager
              page={devices.data.page}
              pageSize={devices.data.page_size}
              total={devices.data.total}
              onPageChange={setPage}
            />
          </div>
        </div>
      )}

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add device</DialogTitle>
          </DialogHeader>
          <div className="flex flex-col gap-3">
            <FormField label="Customer">
              <Select
                value={form.customer_id}
                onChange={(e) => setForm((f) => ({ ...f, customer_id: e.target.value }))}
              >
                <option value="">Select a customer…</option>
                {(customers.data ?? []).map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                    {c.phone ? ` · ${c.phone}` : ''}
                  </option>
                ))}
              </Select>
            </FormField>
            <div className="grid gap-3 sm:grid-cols-2">
              <FormField label="Type">
                <Select
                  value={form.device_type}
                  onChange={(e) => setForm((f) => ({ ...f, device_type: e.target.value }))}
                >
                  {DEVICE_TYPES.map((t) => (
                    <option key={t} value={t}>
                      {t}
                    </option>
                  ))}
                </Select>
              </FormField>
              <FormField label="Brand">
                <Input
                  value={form.brand}
                  onChange={(e) => setForm((f) => ({ ...f, brand: e.target.value }))}
                  placeholder="Samsung, Titan, Honda…"
                />
              </FormField>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <FormField label="Model">
                <Input value={form.model} onChange={(e) => setForm((f) => ({ ...f, model: e.target.value }))} />
              </FormField>
              <FormField label="Colour">
                <Input value={form.color} onChange={(e) => setForm((f) => ({ ...f, color: e.target.value }))} />
              </FormField>
            </div>
            <FormField label="Serial / IMEI">
              <Input
                value={form.imei_serial}
                onChange={(e) => setForm((f) => ({ ...f, imei_serial: e.target.value }))}
              />
            </FormField>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)}>
              Cancel
            </Button>
            <Button onClick={() => create.mutate()} disabled={create.isPending}>
              Add device
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
