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
import type { DeviceCategory, PartWire, SupplierWire } from '@/lib/types'

const CATEGORIES: DeviceCategory[] = ['HHP', 'CE', 'AC', 'REF', 'OTHER']
const WHOLE_OR_BLANK = /^\d*$/

const partSchema = z.object({
  part_number: z.string().min(1, 'Required').max(100),
  description: z.string().min(1, 'Required').max(500),
  category: z.enum(['HHP', 'CE', 'AC', 'REF', 'OTHER']),
  unit_cost_usd: z
    .string()
    .refine((v) => WHOLE_OR_BLANK.test(v), 'Whole number, e.g. 128'),
  default_sell_price_tzs: z
    .string()
    .refine((v) => WHOLE_OR_BLANK.test(v), 'Whole amount, e.g. 450000'),
  compatible_models: z.string().max(2000),
  preferred_supplier_id: z.string(),
  is_serialized: z.enum(['no', 'yes']),
  active: z.boolean(),
})

type PartForm = z.infer<typeof partSchema>

const EMPTY: PartForm = {
  part_number: '',
  description: '',
  category: 'HHP',
  unit_cost_usd: '',
  default_sell_price_tzs: '',
  compatible_models: '',
  preferred_supplier_id: '',
  is_serialized: 'no',
  active: true,
}

/**
 * Parts catalogue (Task 2.1, §4.4): list + search/filter, create/edit. Costs
 * are entered in WHOLE units (USD dollars, TZS shillings) and stored as minor
 * units on the wire; stock levels live on the Stock page.
 */
export function PartsPage() {
  const { can } = useAuth()
  const queryClient = useQueryClient()
  const [page, setPage] = useState(1)
  const [q, setQ] = useState('')
  const [category, setCategory] = useState('')
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editing, setEditing] = useState<PartWire | null>(null)
  const debouncedQ = useDebouncedValue(q, 350)

  const canManage = can('part.manage')

  const parts = useQuery({
    queryKey: ['parts', page, debouncedQ, category],
    queryFn: async () =>
      (
        await api.get<PaginatedResponse<PartWire>>('/parts', {
          params: {
            page,
            page_size: 20,
            ...(debouncedQ ? { q: debouncedQ } : {}),
            ...(category ? { category } : {}),
          },
        })
      ).data,
  })

  const suppliers = useQuery({
    queryKey: ['suppliers', 'options'],
    enabled: can('supplier.read'),
    queryFn: async () =>
      (
        await api.get<PaginatedResponse<SupplierWire>>('/suppliers', {
          params: { page_size: 100, active: true },
        })
      ).data.data,
  })

  const form = useForm<PartForm>({
    resolver: zodResolver(partSchema),
    defaultValues: EMPTY,
  })

  function openCreate() {
    setEditing(null)
    form.reset(EMPTY)
    setDialogOpen(true)
  }

  function openEdit(p: PartWire) {
    setEditing(p)
    form.reset({
      part_number: p.part_number,
      description: p.description,
      category: p.category,
      unit_cost_usd: minorToMajor(p.unit_cost_usd),
      default_sell_price_tzs: minorToMajor(p.default_sell_price_tzs),
      compatible_models: p.compatible_models.join(', '),
      preferred_supplier_id: p.preferred_supplier_id ?? '',
      is_serialized: p.is_serialized ? 'yes' : 'no',
      active: p.active,
    })
    setDialogOpen(true)
  }

  const save = useMutation({
    mutationFn: async (values: PartForm) => {
      const body = {
        part_number: values.part_number,
        description: values.description,
        category: values.category,
        unit_cost_usd: majorToMinor(values.unit_cost_usd) ?? undefined,
        default_sell_price_tzs:
          majorToMinor(values.default_sell_price_tzs) ?? undefined,
        compatible_models: values.compatible_models
          .split(',')
          .map((m) => m.trim())
          .filter(Boolean),
        preferred_supplier_id: values.preferred_supplier_id || null,
        is_serialized: values.is_serialized === 'yes',
        active: values.active,
      }
      if (editing) {
        return (await api.patch<PartWire>(`/parts/${editing.id}`, body)).data
      }
      return (await api.post<PartWire>('/parts', body)).data
    },
    onSuccess: async () => {
      toast.success(editing ? 'Part updated' : 'Part created')
      setDialogOpen(false)
      await queryClient.invalidateQueries({ queryKey: ['parts'] })
    },
    onError: (e) => toast.error(apiErrorMessage(e)),
  })

  const submit = form.handleSubmit((values) => save.mutate(values))

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <Input
          placeholder="Search part number or description…"
          value={q}
          onChange={(e) => {
            setQ(e.target.value)
            setPage(1)
          }}
          className="max-w-xs"
        />
        <Select
          value={category}
          onChange={(e) => {
            setCategory(e.target.value)
            setPage(1)
          }}
          className="w-40"
          aria-label="Filter by category"
        >
          <option value="">All categories</option>
          {CATEGORIES.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </Select>
        <div className="flex-1" />
        {canManage && <Button onClick={openCreate}>New part</Button>}
      </div>

      {parts.isPending && (
        <p className="text-sm text-muted-foreground">Loading…</p>
      )}
      {parts.isError && (
        <p className="text-sm text-destructive">
          {apiErrorMessage(parts.error)}
        </p>
      )}
      {parts.data && (
        <div className="rounded-xl border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Part number</TableHead>
                <TableHead>Description</TableHead>
                <TableHead>Category</TableHead>
                <TableHead className="text-right">Unit cost</TableHead>
                <TableHead className="text-right">Sell price</TableHead>
                <TableHead>Supplier</TableHead>
                <TableHead>Serialized</TableHead>
                <TableHead>Status</TableHead>
                {canManage && <TableHead className="w-20" />}
              </TableRow>
            </TableHeader>
            <TableBody>
              {parts.data.data.length === 0 && (
                <TableRow>
                  <TableCell
                    colSpan={canManage ? 9 : 8}
                    className="text-center text-muted-foreground"
                  >
                    No parts found
                  </TableCell>
                </TableRow>
              )}
              {parts.data.data.map((p) => (
                <TableRow key={p.id}>
                  <TableCell className="font-mono">{p.part_number}</TableCell>
                  <TableCell>{p.description}</TableCell>
                  <TableCell>
                    <Badge variant="outline">{p.category}</Badge>
                  </TableCell>
                  <TableCell className="text-right">
                    {formatMoney(p.unit_cost_usd, 'USD')}
                  </TableCell>
                  <TableCell className="text-right">
                    {formatMoney(p.default_sell_price_tzs, 'TZS')}
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {p.preferred_supplier?.name ?? '—'}
                  </TableCell>
                  <TableCell>
                    {p.is_serialized ? (
                      <Badge variant="secondary">Serial</Badge>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </TableCell>
                  <TableCell>
                    {p.active ? (
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
                        onClick={() => openEdit(p)}
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
              page={parts.data.page}
              pageSize={parts.data.page_size}
              total={parts.data.total}
              onPageChange={setPage}
            />
          </div>
        </div>
      )}

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {editing ? `Edit ${editing.part_number}` : 'New part'}
            </DialogTitle>
            <DialogDescription>
              Costs are entered in whole units (USD dollars, TZS shillings).
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <FormField
                label="Part number"
                htmlFor="part-number"
                error={form.formState.errors.part_number?.message}
              >
                <Input id="part-number" {...form.register('part_number')} />
              </FormField>
              <FormField
                label="Category"
                htmlFor="part-category"
                error={form.formState.errors.category?.message}
              >
                <Select id="part-category" {...form.register('category')}>
                  {CATEGORIES.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </Select>
              </FormField>
            </div>
            <FormField
              label="Description"
              htmlFor="part-desc"
              error={form.formState.errors.description?.message}
            >
              <Input id="part-desc" {...form.register('description')} />
            </FormField>
            <div className="grid gap-4 sm:grid-cols-2">
              <FormField
                label="Unit cost (USD)"
                htmlFor="part-cost"
                error={form.formState.errors.unit_cost_usd?.message}
                hint="Landed cost per unit"
              >
                <Input
                  id="part-cost"
                  inputMode="numeric"
                  {...form.register('unit_cost_usd')}
                />
              </FormField>
              <FormField
                label="Sell price (TZS)"
                htmlFor="part-sell"
                error={form.formState.errors.default_sell_price_tzs?.message}
                hint="OW counter price"
              >
                <Input
                  id="part-sell"
                  inputMode="numeric"
                  {...form.register('default_sell_price_tzs')}
                />
              </FormField>
            </div>
            <FormField
              label="Compatible models"
              htmlFor="part-models"
              error={form.formState.errors.compatible_models?.message}
              hint="Comma-separated model codes, e.g. S24, S24U"
            >
              <Input id="part-models" {...form.register('compatible_models')} />
            </FormField>
            {can('supplier.read') && (
              <FormField
                label="Preferred supplier"
                htmlFor="part-supplier"
                hint="Drives suggested reorder grouping"
              >
                <Select
                  id="part-supplier"
                  {...form.register('preferred_supplier_id')}
                >
                  <option value="">— none —</option>
                  {suppliers.data?.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </Select>
              </FormField>
            )}
            <div className="grid gap-4 sm:grid-cols-2">
              <FormField
                label="Serial tracked"
                htmlFor="part-serial"
                error={form.formState.errors.is_serialized?.message}
              >
                <Select id="part-serial" {...form.register('is_serialized')}>
                  <option value="no">No</option>
                  <option value="yes">Yes (unit-by-unit)</option>
                </Select>
              </FormField>
              {editing && (
                <FormField label="Status" htmlFor="part-active">
                  <label className="flex h-9 items-center gap-2 text-sm">
                    <input
                      id="part-active"
                      type="checkbox"
                      className="size-4"
                      {...form.register('active')}
                    />
                    Active
                  </label>
                </FormField>
              )}
            </div>
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
