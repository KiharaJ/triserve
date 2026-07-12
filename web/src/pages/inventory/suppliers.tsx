import { zodResolver } from '@hookform/resolvers/zod'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { useForm } from 'react-hook-form'
import { toast } from 'sonner'
import { z } from 'zod'
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
import type { SupplierWire } from '@/lib/types'

const WHOLE_OR_BLANK = /^\d*$/

const supplierSchema = z.object({
  name: z.string().min(2, 'At least 2 characters').max(255),
  contact_person: z.string().max(255),
  phone: z.string().max(50),
  email: z.string().refine((v) => v === '' || /.+@.+\..+/.test(v), {
    message: 'Enter a valid email',
  }),
  default_currency: z.string().length(3, '3-letter code'),
  lead_time_days: z
    .string()
    .refine((v) => WHOLE_OR_BLANK.test(v), 'Whole number of days'),
  payment_terms: z.string().max(100),
  active: z.boolean(),
})

type SupplierForm = z.infer<typeof supplierSchema>

const EMPTY: SupplierForm = {
  name: '',
  contact_person: '',
  phone: '',
  email: '',
  default_currency: 'USD',
  lead_time_days: '',
  payment_terms: '',
  active: true,
}

/**
 * Suppliers (Task 2.5, §4.4b): the parts-vendor master — list + search,
 * create/edit. Parts point at a preferred supplier; POs (Task 2.6) buy from
 * these vendors.
 */
export function SuppliersPage() {
  const { can } = useAuth()
  const queryClient = useQueryClient()
  const [page, setPage] = useState(1)
  const [q, setQ] = useState('')
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editing, setEditing] = useState<SupplierWire | null>(null)
  const debouncedQ = useDebouncedValue(q, 350)

  const canManage = can('supplier.manage')

  const suppliers = useQuery({
    queryKey: ['suppliers', page, debouncedQ],
    queryFn: async () =>
      (
        await api.get<PaginatedResponse<SupplierWire>>('/suppliers', {
          params: { page, page_size: 20, ...(debouncedQ ? { q: debouncedQ } : {}) },
        })
      ).data,
  })

  const form = useForm<SupplierForm>({
    resolver: zodResolver(supplierSchema),
    defaultValues: EMPTY,
  })

  function openCreate() {
    setEditing(null)
    form.reset(EMPTY)
    setDialogOpen(true)
  }

  function openEdit(s: SupplierWire) {
    setEditing(s)
    form.reset({
      name: s.name,
      contact_person: s.contact_person ?? '',
      phone: s.phone ?? '',
      email: s.email ?? '',
      default_currency: s.default_currency,
      lead_time_days: s.lead_time_days === null ? '' : String(s.lead_time_days),
      payment_terms: s.payment_terms ?? '',
      active: s.active,
    })
    setDialogOpen(true)
  }

  const save = useMutation({
    mutationFn: async (values: SupplierForm) => {
      const body = {
        name: values.name,
        contact_person: values.contact_person || null,
        phone: values.phone || null,
        email: values.email || null,
        default_currency: values.default_currency.toUpperCase(),
        lead_time_days:
          values.lead_time_days === '' ? null : Number(values.lead_time_days),
        payment_terms: values.payment_terms || null,
        active: values.active,
      }
      if (editing) {
        return (await api.patch<SupplierWire>(`/suppliers/${editing.id}`, body))
          .data
      }
      return (await api.post<SupplierWire>('/suppliers', body)).data
    },
    onSuccess: async () => {
      toast.success(editing ? 'Supplier updated' : 'Supplier created')
      setDialogOpen(false)
      await queryClient.invalidateQueries({ queryKey: ['suppliers'] })
    },
    onError: (e) => toast.error(apiErrorMessage(e)),
  })

  const submit = form.handleSubmit((values) => save.mutate(values))

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <Input
          placeholder="Search name or contact…"
          value={q}
          onChange={(e) => {
            setQ(e.target.value)
            setPage(1)
          }}
          className="max-w-xs"
        />
        <div className="flex-1" />
        {canManage && <Button onClick={openCreate}>New supplier</Button>}
      </div>

      {suppliers.isPending && (
        <p className="text-sm text-muted-foreground">Loading…</p>
      )}
      {suppliers.isError && (
        <p className="text-sm text-destructive">
          {apiErrorMessage(suppliers.error)}
        </p>
      )}
      {suppliers.data && (
        <div className="overflow-hidden rounded-xl border bg-card shadow-sm">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Contact</TableHead>
                <TableHead>Currency</TableHead>
                <TableHead className="text-right">Lead time</TableHead>
                <TableHead>Terms</TableHead>
                <TableHead>Status</TableHead>
                {canManage && <TableHead className="w-20" />}
              </TableRow>
            </TableHeader>
            <TableBody>
              {suppliers.data.data.length === 0 && (
                <TableRow>
                  <TableCell
                    colSpan={canManage ? 7 : 6}
                    className="text-center text-muted-foreground"
                  >
                    No suppliers
                  </TableCell>
                </TableRow>
              )}
              {suppliers.data.data.map((s) => (
                <TableRow key={s.id}>
                  <TableCell className="font-medium">{s.name}</TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {s.contact_person ?? '—'}
                    {s.phone ? ` · ${s.phone}` : ''}
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline">{s.default_currency}</Badge>
                  </TableCell>
                  <TableCell className="text-right text-muted-foreground">
                    {s.lead_time_days === null ? '—' : `${s.lead_time_days}d`}
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {s.payment_terms ?? '—'}
                  </TableCell>
                  <TableCell>
                    {s.active ? (
                      <Badge variant="success">Active</Badge>
                    ) : (
                      <Badge variant="destructive">Inactive</Badge>
                    )}
                  </TableCell>
                  {canManage && (
                    <TableCell>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => openEdit(s)}
                      >
                        Edit
                      </Button>
                    </TableCell>
                  )}
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <div className="px-3 pb-3">
            <Pager
              page={suppliers.data.page}
              pageSize={suppliers.data.page_size}
              total={suppliers.data.total}
              onPageChange={setPage}
            />
          </div>
        </div>
      )}

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {editing ? `Edit ${editing.name}` : 'New supplier'}
            </DialogTitle>
            <DialogDescription>
              The vendor you buy spare parts from.
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-4">
            <FormField
              label="Name"
              htmlFor="sup-name"
              error={form.formState.errors.name?.message}
            >
              <Input id="sup-name" {...form.register('name')} />
            </FormField>
            <div className="grid gap-4 sm:grid-cols-2">
              <FormField
                label="Contact person"
                htmlFor="sup-contact"
                error={form.formState.errors.contact_person?.message}
              >
                <Input id="sup-contact" {...form.register('contact_person')} />
              </FormField>
              <FormField
                label="Phone"
                htmlFor="sup-phone"
                error={form.formState.errors.phone?.message}
              >
                <Input id="sup-phone" {...form.register('phone')} />
              </FormField>
              <FormField
                label="Email"
                htmlFor="sup-email"
                error={form.formState.errors.email?.message}
              >
                <Input id="sup-email" {...form.register('email')} />
              </FormField>
              <FormField
                label="Default currency"
                htmlFor="sup-currency"
                error={form.formState.errors.default_currency?.message}
                hint="USD for Samsung parts, TZS for local"
              >
                <Input
                  id="sup-currency"
                  maxLength={3}
                  className="uppercase"
                  {...form.register('default_currency')}
                />
              </FormField>
              <FormField
                label="Lead time (days)"
                htmlFor="sup-lead"
                error={form.formState.errors.lead_time_days?.message}
              >
                <Input
                  id="sup-lead"
                  inputMode="numeric"
                  {...form.register('lead_time_days')}
                />
              </FormField>
              <FormField
                label="Payment terms"
                htmlFor="sup-terms"
                error={form.formState.errors.payment_terms?.message}
              >
                <Input id="sup-terms" {...form.register('payment_terms')} />
              </FormField>
            </div>
            {editing && (
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  className="size-4"
                  {...form.register('active')}
                />
                Active
              </label>
            )}
            <DialogFooter>
              <Button
                type="button"
                variant="ghost"
                onClick={() => setDialogOpen(false)}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={save.isPending}>
                {save.isPending ? 'Saving…' : 'Save'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  )
}
