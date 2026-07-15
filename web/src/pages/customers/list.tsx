import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Plus, Search, User } from 'lucide-react'
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
import {
  CUSTOMER_TYPES,
  type CustomerType,
  type CustomerWire,
} from '@/lib/types'

function initials(name: string): string {
  return name
    .split(/\s+/)
    .slice(0, 2)
    .map((n) => n[0])
    .join('')
    .toUpperCase()
}

/**
 * Customers list (Phase 5 CRM) — browse/search all customers and add one
 * directly (previously customers were only created inside job intake). Each
 * row links to the Customer 360.
 */
export function CustomersListPage() {
  const { can } = useAuth()
  const queryClient = useQueryClient()
  const [page, setPage] = useState(1)
  const [search, setSearch] = useState('')
  const debouncedSearch = useDebouncedValue(search, 350)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [form, setForm] = useState({
    name: '',
    phone: '',
    alt_phone: '',
    email: '',
    location: '',
    type: 'INDIVIDUAL' as CustomerType,
    dealer_name: '',
  })

  const canCreate = can('customer.create')

  const customers = useQuery({
    queryKey: ['customers', page, debouncedSearch],
    queryFn: async () =>
      (
        await api.get<PaginatedResponse<CustomerWire>>('/customers', {
          params: { page, page_size: 20, ...(debouncedSearch ? { q: debouncedSearch } : {}) },
        })
      ).data,
  })

  const create = useMutation({
    mutationFn: async () => {
      if (!form.name.trim()) throw new Error('Enter a name')
      return (
        await api.post<CustomerWire>('/customers', {
          name: form.name,
          phone: form.phone || undefined,
          alt_phone: form.alt_phone || undefined,
          email: form.email || undefined,
          location: form.location || undefined,
          type: form.type,
          dealer_name:
            form.type !== 'INDIVIDUAL'
              ? form.dealer_name || undefined
              : undefined,
        })
      ).data
    },
    onSuccess: async () => {
      toast.success('Customer added')
      setDialogOpen(false)
      await queryClient.invalidateQueries({ queryKey: ['customers'] })
    },
    onError: (e) =>
      toast.error(e instanceof Error ? e.message : apiErrorMessage(e)),
  })

  function openCreate() {
    setForm({
      name: '',
      phone: '',
      alt_phone: '',
      email: '',
      location: '',
      type: 'INDIVIDUAL',
      dealer_name: '',
    })
    setDialogOpen(true)
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative w-72">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Search name or phone…"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value)
              setPage(1)
            }}
            className="pl-8"
          />
        </div>
        <div className="flex-1" />
        {canCreate && (
          <Button onClick={openCreate} className="gap-1.5">
            <Plus className="size-4" /> Add customer
          </Button>
        )}
      </div>

      {customers.isPending && <p className="text-sm text-muted-foreground">Loading…</p>}
      {customers.isError && (
        <p className="text-sm text-destructive">{apiErrorMessage(customers.error)}</p>
      )}
      {customers.data && (
        <div className="overflow-hidden rounded-xl border bg-card shadow-sm">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Customer</TableHead>
                <TableHead>Phone</TableHead>
                <TableHead>Location</TableHead>
                <TableHead>Type</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {customers.data.data.length === 0 && (
                <TableRow>
                  <TableCell colSpan={5} className="py-10 text-center text-muted-foreground">
                    No customers found.
                  </TableCell>
                </TableRow>
              )}
              {customers.data.data.map((c) => (
                <TableRow key={c.id}>
                  <TableCell>
                    <Link to={`/customers/${c.id}`} className="flex items-center gap-2.5 hover:underline">
                      <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-indigo-500 to-blue-600 text-xs font-semibold text-white">
                        {initials(c.name)}
                      </span>
                      <span className="font-medium">{c.name}</span>
                    </Link>
                  </TableCell>
                  <TableCell className="font-mono text-sm">{c.phone ?? '—'}</TableCell>
                  <TableCell className="text-muted-foreground">{c.location ?? '—'}</TableCell>
                  <TableCell>
                    {c.type === 'DEALER' ? (
                      <Badge variant="info">Dealer</Badge>
                    ) : c.type === 'BUSINESS' ? (
                      <Badge variant="secondary">Business</Badge>
                    ) : (
                      <span className="text-muted-foreground">Individual</span>
                    )}
                  </TableCell>
                  <TableCell className="text-right">
                    <Button asChild variant="ghost" size="sm">
                      <Link to={`/customers/${c.id}`}>
                        <User className="size-4" /> View
                      </Link>
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <div className="border-t px-4 py-3">
            <Pager
              page={customers.data.page}
              pageSize={customers.data.page_size}
              total={customers.data.total}
              onPageChange={setPage}
            />
          </div>
        </div>
      )}

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add customer</DialogTitle>
          </DialogHeader>
          <div className="flex flex-col gap-3">
            <FormField label="Name">
              <Input value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} />
            </FormField>
            <div className="grid gap-3 sm:grid-cols-2">
              <FormField label="Phone">
                <Input value={form.phone} onChange={(e) => setForm((f) => ({ ...f, phone: e.target.value }))} placeholder="0765…" />
              </FormField>
              <FormField label="Alternate phone">
                <Input value={form.alt_phone} onChange={(e) => setForm((f) => ({ ...f, alt_phone: e.target.value }))} />
              </FormField>
              <FormField label="Email">
                <Input type="email" value={form.email} onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))} />
              </FormField>
              <FormField label="Location">
                <Input value={form.location} onChange={(e) => setForm((f) => ({ ...f, location: e.target.value }))} />
              </FormField>
            </div>
            <FormField label="Type">
              <Select
                value={form.type}
                onChange={(e) =>
                  setForm((f) => ({ ...f, type: e.target.value as CustomerType }))
                }
              >
                {CUSTOMER_TYPES.map((t) => (
                  <option key={t.value} value={t.value}>
                    {t.label}
                  </option>
                ))}
              </Select>
            </FormField>
            {form.type !== 'INDIVIDUAL' && (
              <FormField label="Business / dealer name">
                <Input value={form.dealer_name} onChange={(e) => setForm((f) => ({ ...f, dealer_name: e.target.value }))} />
              </FormField>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)}>
              Cancel
            </Button>
            <Button onClick={() => create.mutate()} disabled={create.isPending}>
              Add customer
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
