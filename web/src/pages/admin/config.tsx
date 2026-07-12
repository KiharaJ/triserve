import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState, type ReactNode } from 'react'
import { useForm } from 'react-hook-form'
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { api, apiErrorMessage } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { formatMoney, majorToMinor, minorToMajor } from '@/lib/format'

/**
 * Config screens (Task 0.7, DESIGN.md §4.14 / E17): simple CRUD tables for
 * payment methods, fault codes, repair actions, tax rates and currencies —
 * one generic table+dialog driven by a per-table field spec so validation
 * and toasts behave identically across all five.
 */

type Row = { id: string } & Record<string, unknown>

interface FieldSpec {
  name: string
  label: string
  /** 'money' renders/enters WHOLE TZS and travels as minor-unit strings. */
  kind: 'text' | 'money' | 'percent'
  required: boolean
  placeholder?: string
  hint?: string
  pattern?: { value: RegExp; message: string }
}

interface TableSpec {
  endpoint: string
  singular: string
  plural: string
  fields: FieldSpec[]
  /** Wire field flagged Active/Inactive — currencies don't have one. */
  hasActive: boolean
  extraColumns?: Array<{ header: string; render: (row: Row) => ReactNode }>
}

const CODE_FIELD: FieldSpec = {
  name: 'code',
  label: 'Code',
  kind: 'text',
  required: true,
  pattern: {
    value: /^[A-Za-z0-9_-]+$/,
    message: 'Letters, digits, "-" and "_" only',
  },
}

const TABLES: TableSpec[] = [
  {
    endpoint: '/payment-methods',
    singular: 'payment method',
    plural: 'Payment methods',
    hasActive: true,
    fields: [
      CODE_FIELD,
      { name: 'label', label: 'Label', kind: 'text', required: true },
    ],
  },
  {
    endpoint: '/fault-codes',
    singular: 'fault code',
    plural: 'Fault codes',
    hasActive: true,
    fields: [
      CODE_FIELD,
      { name: 'label', label: 'Label', kind: 'text', required: true },
    ],
  },
  {
    endpoint: '/repair-actions',
    singular: 'repair action',
    plural: 'Repair actions',
    hasActive: true,
    fields: [
      CODE_FIELD,
      { name: 'label', label: 'Label', kind: 'text', required: true },
      {
        name: 'default_labour_price',
        label: 'Default labour price (TZS)',
        kind: 'money',
        required: false,
        placeholder: 'e.g. 25000',
        hint: 'Whole TZS; leave blank for none',
      },
    ],
    extraColumns: [
      {
        header: 'Labour price',
        render: (row) =>
          formatMoney(row.default_labour_price as string | null),
      },
    ],
  },
  {
    endpoint: '/tax-rates',
    singular: 'tax rate',
    plural: 'Tax rates',
    hasActive: true,
    fields: [
      CODE_FIELD,
      { name: 'label', label: 'Label', kind: 'text', required: true },
      {
        name: 'percent',
        label: 'Percent',
        kind: 'percent',
        required: true,
        placeholder: 'e.g. 18',
        pattern: {
          value: /^\d{1,3}(\.\d{1,3})?$/,
          message: 'A decimal like "18" or "18.5"',
        },
      },
    ],
    extraColumns: [
      {
        header: 'Percent',
        render: (row) => `${row.percent as string}%`,
      },
    ],
  },
  {
    endpoint: '/currencies',
    singular: 'currency',
    plural: 'Currencies',
    hasActive: false,
    fields: [
      {
        name: 'code',
        label: 'ISO code',
        kind: 'text',
        required: true,
        placeholder: 'USD',
        pattern: {
          value: /^[A-Za-z]{3}$/,
          message: 'A 3-letter ISO code, e.g. USD',
        },
      },
      { name: 'name', label: 'Name', kind: 'text', required: true },
      { name: 'symbol', label: 'Symbol', kind: 'text', required: true },
    ],
    extraColumns: [
      {
        header: 'Base',
        render: (row) =>
          (row.is_base as boolean) ? <Badge variant="success">Base</Badge> : '—',
      },
    ],
  },
]

function ConfigCrudTable({ spec }: { spec: TableSpec }) {
  const { can } = useAuth()
  const queryClient = useQueryClient()
  const [page, setPage] = useState(1)
  const [q, setQ] = useState('')
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editing, setEditing] = useState<Row | null>(null)

  const canManage = can('config.manage')
  const queryKey = ['config', spec.endpoint]

  const rows = useQuery({
    queryKey: [...queryKey, page, q],
    queryFn: async () =>
      (
        await api.get<PaginatedResponse<Row>>(spec.endpoint, {
          params: { page, page_size: 20, ...(q ? { q } : {}) },
        })
      ).data,
  })

  const form = useForm<Record<string, string>>({ defaultValues: {} })

  function defaultsFor(row: Row | null): Record<string, string> {
    const values: Record<string, string> = {}
    for (const f of spec.fields) {
      const raw = row?.[f.name]
      values[f.name] =
        f.kind === 'money'
          ? minorToMajor(raw as string | null | undefined)
          : ((raw as string | null | undefined) ?? '')
    }
    return values
  }

  function openCreate() {
    setEditing(null)
    form.reset(defaultsFor(null))
    setDialogOpen(true)
  }

  function openEdit(row: Row) {
    setEditing(row)
    form.reset(defaultsFor(row))
    setDialogOpen(true)
  }

  const save = useMutation({
    mutationFn: async (values: Record<string, string>) => {
      const payload: Record<string, unknown> = {}
      for (const f of spec.fields) {
        const v = values[f.name] ?? ''
        if (f.kind === 'money') {
          payload[f.name] = majorToMinor(v)
        } else if (v === '' && !f.required) {
          payload[f.name] = editing ? null : undefined
        } else {
          payload[f.name] = v
        }
      }
      if (editing) {
        return (await api.patch<Row>(`${spec.endpoint}/${editing.id}`, payload))
          .data
      }
      return (await api.post<Row>(spec.endpoint, payload)).data
    },
    onSuccess: async () => {
      toast.success(
        editing ? `Updated ${spec.singular}` : `Created ${spec.singular}`,
      )
      setDialogOpen(false)
      await queryClient.invalidateQueries({ queryKey })
    },
    onError: (e) => toast.error(apiErrorMessage(e)),
  })

  const remove = useMutation({
    mutationFn: async (id: string) => api.delete(`${spec.endpoint}/${id}`),
    onSuccess: async () => {
      toast.success(`Deleted ${spec.singular}`)
      await queryClient.invalidateQueries({ queryKey })
    },
    onError: (e) => toast.error(apiErrorMessage(e)),
  })

  const submit = form.handleSubmit((values) => save.mutate(values))

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-2">
        <Input
          placeholder="Search…"
          value={q}
          onChange={(e) => {
            setQ(e.target.value)
            setPage(1)
          }}
          className="max-w-xs"
        />
        {canManage && (
          <Button onClick={openCreate}>New {spec.singular}</Button>
        )}
      </div>

      {rows.isPending && (
        <p className="text-sm text-muted-foreground">Loading…</p>
      )}
      {rows.isError && (
        <p className="text-sm text-destructive">
          {apiErrorMessage(rows.error)}
        </p>
      )}
      {rows.data && (
        <div className="overflow-hidden rounded-xl border bg-card shadow-sm">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Code</TableHead>
                <TableHead>
                  {spec.endpoint === '/currencies' ? 'Name' : 'Label'}
                </TableHead>
                {spec.extraColumns?.map((c) => (
                  <TableHead key={c.header}>{c.header}</TableHead>
                ))}
                {spec.hasActive && <TableHead>Status</TableHead>}
                {canManage && <TableHead className="w-32" />}
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.data.data.map((row) => (
                <TableRow key={row.id}>
                  <TableCell className="font-mono">
                    {row.code as string}
                  </TableCell>
                  <TableCell>
                    {(row.label ?? row.name) as string}
                  </TableCell>
                  {spec.extraColumns?.map((c) => (
                    <TableCell key={c.header}>{c.render(row)}</TableCell>
                  ))}
                  {spec.hasActive && (
                    <TableCell>
                      {(row.active as boolean) ? (
                        <Badge variant="success">Active</Badge>
                      ) : (
                        <Badge variant="secondary">Inactive</Badge>
                      )}
                    </TableCell>
                  )}
                  {canManage && (
                    <TableCell>
                      <div className="flex gap-1">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => openEdit(row)}
                        >
                          Edit
                        </Button>
                        <Button
                          variant="destructive"
                          size="sm"
                          disabled={remove.isPending}
                          onClick={() => {
                            if (
                              window.confirm(
                                `Delete ${spec.singular} "${row.code as string}"?`,
                              )
                            ) {
                              remove.mutate(row.id)
                            }
                          }}
                        >
                          Delete
                        </Button>
                      </div>
                    </TableCell>
                  )}
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <div className="px-3 pb-3">
            <Pager
              page={rows.data.page}
              pageSize={rows.data.page_size}
              total={rows.data.total}
              onPageChange={setPage}
            />
          </div>
        </div>
      )}

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {editing
                ? `Edit ${spec.singular} ${editing.code as string}`
                : `New ${spec.singular}`}
            </DialogTitle>
            <DialogDescription>
              Changes are audited and take effect immediately.
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-4">
            {spec.fields.map((f) => (
              <FormField
                key={f.name}
                label={f.label}
                htmlFor={`cfg-${f.name}`}
                hint={f.hint}
                error={form.formState.errors[f.name]?.message}
              >
                <Input
                  id={`cfg-${f.name}`}
                  placeholder={f.placeholder}
                  {...form.register(f.name, {
                    ...(f.required
                      ? { required: `${f.label} is required` }
                      : {}),
                    ...(f.pattern ? { pattern: f.pattern } : {}),
                    ...(f.kind === 'money'
                      ? {
                          validate: (v) => {
                            try {
                              majorToMinor(v)
                              return true
                            } catch {
                              return 'Enter a whole amount, e.g. 150000'
                            }
                          },
                        }
                      : {}),
                  })}
                />
              </FormField>
            ))}
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

export function ConfigPage() {
  return (
    <Tabs defaultValue={TABLES[0].endpoint}>
      <TabsList>
        {TABLES.map((t) => (
          <TabsTrigger key={t.endpoint} value={t.endpoint}>
            {t.plural}
          </TabsTrigger>
        ))}
      </TabsList>
      {TABLES.map((t) => (
        <TabsContent key={t.endpoint} value={t.endpoint}>
          <ConfigCrudTable spec={t} />
        </TabsContent>
      ))}
    </Tabs>
  )
}
