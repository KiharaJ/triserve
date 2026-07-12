import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  ClipboardCheck,
  Plus,
  Search,
  Settings2,
  SlidersHorizontal,
} from 'lucide-react'
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
import { useDebouncedValue } from '@/lib/use-debounced-value'
import type {
  BranchWire,
  InventoryWire,
  PartWire,
  StockChangeResult,
} from '@/lib/types'

type Mode = 'add' | 'adjust' | 'count' | 'settings'

/**
 * Stock (Task 2.1, §4.4 / E10): per-branch stock buckets with derived
 * available (on_hand − reserved − damaged) and low-stock flags. Storekeepers
 * adjust/count/settle stock here; adjustments over the approval threshold are
 * HELD (the response says so) and nothing moves until approved.
 */
export function StockPage() {
  const { can } = useAuth()
  const queryClient = useQueryClient()
  const [page, setPage] = useState(1)
  const [q, setQ] = useState('')
  const [branchFilter, setBranchFilter] = useState('')
  const [lowOnly, setLowOnly] = useState(false)
  const debouncedQ = useDebouncedValue(q, 350)

  // Dialog state: the acting row (null for "Add stock") + which action.
  const [mode, setMode] = useState<Mode | null>(null)
  const [row, setRow] = useState<InventoryWire | null>(null)
  const [fields, setFields] = useState({
    branch_id: '',
    part_id: '',
    delta: '',
    counted_qty: '',
    movement_type: 'ADJUSTMENT',
    reason: '',
    bin_location: '',
    reorder_level: '',
  })

  const canAdjust = can('inventory.adjust')
  const canCount = can('inventory.count')

  const branches = useQuery({
    queryKey: ['branches', 'all'],
    queryFn: async () =>
      (
        await api.get<PaginatedResponse<BranchWire>>('/branches', {
          params: { page_size: 100 },
        })
      ).data.data,
  })

  const partOptions = useQuery({
    queryKey: ['parts', 'options'],
    queryFn: async () =>
      (
        await api.get<PaginatedResponse<PartWire>>('/parts', {
          params: { page_size: 100, active: true },
        })
      ).data.data,
  })

  const stock = useQuery({
    queryKey: ['inventory', page, debouncedQ, branchFilter, lowOnly],
    queryFn: async () =>
      (
        await api.get<PaginatedResponse<InventoryWire>>('/inventory', {
          params: {
            page,
            page_size: 20,
            ...(debouncedQ ? { q: debouncedQ } : {}),
            ...(branchFilter ? { branch_id: branchFilter } : {}),
            ...(lowOnly ? { low_stock: true } : {}),
          },
        })
      ).data,
  })

  function openDialog(m: Mode, r: InventoryWire | null) {
    setMode(m)
    setRow(r)
    setFields({
      branch_id: r?.branch_id ?? '',
      part_id: r?.part_id ?? '',
      delta: '',
      counted_qty: r ? String(r.qty_on_hand) : '',
      movement_type: 'ADJUSTMENT',
      reason: '',
      bin_location: r?.bin_location ?? '',
      reorder_level: r ? String(r.reorder_level) : '',
    })
  }

  const invalidate = async () => {
    await queryClient.invalidateQueries({ queryKey: ['inventory'] })
  }

  /** adjust + count return the same StockChangeResult (applied or HELD). */
  function onChangeResult(res: StockChangeResult, appliedMsg: string) {
    if (res.held) {
      toast.warning('Sent for approval — nothing moved until it is approved')
    } else {
      toast.success(appliedMsg)
    }
    setMode(null)
  }

  const adjust = useMutation({
    mutationFn: async () =>
      (
        await api.post<StockChangeResult>('/inventory/adjust', {
          branch_id: fields.branch_id,
          part_id: fields.part_id,
          delta: Number(fields.delta),
          movement_type: fields.movement_type,
          reason: fields.reason,
        })
      ).data,
    onSuccess: async (res) => {
      onChangeResult(res, 'Stock adjusted')
      await invalidate()
    },
    onError: (e) => toast.error(apiErrorMessage(e)),
  })

  const count = useMutation({
    mutationFn: async () =>
      (
        await api.post<StockChangeResult>('/inventory/count', {
          branch_id: fields.branch_id,
          part_id: fields.part_id,
          counted_qty: Number(fields.counted_qty),
          ...(fields.reason ? { reason: fields.reason } : {}),
        })
      ).data,
    onSuccess: async (res) => {
      onChangeResult(res, 'Stock reconciled to count')
      await invalidate()
    },
    onError: (e) => toast.error(apiErrorMessage(e)),
  })

  const settings = useMutation({
    mutationFn: async () =>
      (
        await api.patch<InventoryWire>('/inventory/settings', {
          branch_id: fields.branch_id,
          part_id: fields.part_id,
          bin_location: fields.bin_location || null,
          ...(fields.reorder_level !== ''
            ? { reorder_level: Number(fields.reorder_level) }
            : {}),
        })
      ).data,
    onSuccess: async () => {
      toast.success('Stock settings saved')
      setMode(null)
      await invalidate()
    },
    onError: (e) => toast.error(apiErrorMessage(e)),
  })

  const busy = adjust.isPending || count.isPending || settings.isPending

  function onSubmit() {
    if (mode === 'add' || mode === 'adjust') adjust.mutate()
    else if (mode === 'count') count.mutate()
    else if (mode === 'settings') settings.mutate()
  }

  const partLabel = (p: PartWire) => `${p.part_number} — ${p.description}`

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative max-w-xs flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Search part number or description…"
            value={q}
            onChange={(e) => {
              setQ(e.target.value)
              setPage(1)
            }}
            className="pl-8"
          />
        </div>
        <Select
          value={branchFilter}
          onChange={(e) => {
            setBranchFilter(e.target.value)
            setPage(1)
          }}
          className="w-44"
          aria-label="Filter by branch"
        >
          <option value="">All branches</option>
          {branches.data?.map((b) => (
            <option key={b.id} value={b.id}>
              {b.code} — {b.name}
            </option>
          ))}
        </Select>
        <Button
          variant={lowOnly ? 'default' : 'outline'}
          onClick={() => {
            setLowOnly((v) => !v)
            setPage(1)
          }}
          className={
            lowOnly ? '' : 'border-amber-300 text-amber-700 hover:bg-amber-50 dark:border-amber-500/40 dark:text-amber-400 dark:hover:bg-amber-500/10'
          }
        >
          Low stock only
        </Button>
        <div className="flex-1" />
        {canAdjust && (
          <Button onClick={() => openDialog('add', null)} className="gap-1.5">
            <Plus className="size-4" /> Add stock
          </Button>
        )}
      </div>

      {stock.isPending && (
        <p className="text-sm text-muted-foreground">Loading…</p>
      )}
      {stock.isError && (
        <p className="text-sm text-destructive">
          {apiErrorMessage(stock.error)}
        </p>
      )}
      {stock.data && (
        <div className="overflow-hidden rounded-xl border bg-card shadow-sm">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Part</TableHead>
                <TableHead>Bin</TableHead>
                <TableHead className="text-right">On hand</TableHead>
                <TableHead className="text-right">Reserved</TableHead>
                <TableHead className="text-right">Damaged</TableHead>
                <TableHead className="text-right">Available</TableHead>
                <TableHead className="text-right">Reorder</TableHead>
                {(canAdjust || canCount) && <TableHead className="w-40 text-right pr-4">Actions</TableHead>}
              </TableRow>
            </TableHeader>
            <TableBody>
              {stock.data.data.length === 0 && (
                <TableRow>
                  <TableCell
                    colSpan={8}
                    className="py-10 text-center text-muted-foreground"
                  >
                    No stock rows
                  </TableCell>
                </TableRow>
              )}
              {stock.data.data.map((i) => {
                const out = i.qty_available <= 0
                return (
                  <TableRow key={i.id}>
                    <TableCell>
                      <div className="flex items-center gap-3">
                        <span
                          className={
                            'flex size-8 shrink-0 items-center justify-center rounded-lg text-xs font-semibold ' +
                            (out
                              ? 'bg-rose-500/15 text-rose-600 dark:text-rose-400'
                              : i.low_stock
                                ? 'bg-amber-500/15 text-amber-600 dark:text-amber-400'
                                : 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400')
                          }
                        >
                          {i.part.part_number.slice(0, 2).toUpperCase()}
                        </span>
                        <div className="flex min-w-0 flex-col">
                          <span className="font-mono text-sm font-medium">
                            {i.part.part_number}
                          </span>
                          <span className="truncate text-xs text-muted-foreground">
                            {i.part.description}
                          </span>
                        </div>
                      </div>
                    </TableCell>
                    <TableCell>
                      {i.bin_location ? (
                        <Badge variant="outline" className="font-mono">
                          {i.bin_location}
                        </Badge>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </TableCell>
                    <TableCell className="text-right font-medium tabular-nums">
                      {i.qty_on_hand}
                    </TableCell>
                    <TableCell className="text-right tabular-nums text-muted-foreground">
                      {i.qty_reserved || '—'}
                    </TableCell>
                    <TableCell
                      className={
                        'text-right tabular-nums ' +
                        (i.qty_damaged > 0
                          ? 'font-medium text-rose-600 dark:text-rose-400'
                          : 'text-muted-foreground')
                      }
                    >
                      {i.qty_damaged || '—'}
                    </TableCell>
                    <TableCell className="text-right">
                      <span className="inline-flex items-center justify-end gap-2">
                        <span
                          className={
                            'tabular-nums font-semibold ' +
                            (out
                              ? 'text-rose-600 dark:text-rose-400'
                              : i.low_stock
                                ? 'text-amber-600 dark:text-amber-400'
                                : '')
                          }
                        >
                          {i.qty_available}
                        </span>
                        {out ? (
                          <Badge variant="destructive">Out</Badge>
                        ) : i.low_stock ? (
                          <Badge variant="warning">Low</Badge>
                        ) : null}
                      </span>
                    </TableCell>
                    <TableCell className="text-right tabular-nums text-muted-foreground">
                      {i.reorder_level}
                    </TableCell>
                    {(canAdjust || canCount) && (
                      <TableCell className="pr-4">
                        <div className="flex justify-end gap-1.5">
                          {canAdjust && (
                            <Button
                              variant="outline"
                              size="icon"
                              title="Adjust stock"
                              aria-label="Adjust stock"
                              className="size-8 border-blue-200 text-blue-600 hover:bg-blue-50 hover:text-blue-700 dark:border-blue-500/40 dark:text-blue-400 dark:hover:bg-blue-500/10"
                              onClick={() => openDialog('adjust', i)}
                            >
                              <SlidersHorizontal className="size-4" />
                            </Button>
                          )}
                          {canCount && (
                            <Button
                              variant="outline"
                              size="icon"
                              title="Stock count"
                              aria-label="Stock count"
                              className="size-8 border-amber-200 text-amber-600 hover:bg-amber-50 hover:text-amber-700 dark:border-amber-500/40 dark:text-amber-400 dark:hover:bg-amber-500/10"
                              onClick={() => openDialog('count', i)}
                            >
                              <ClipboardCheck className="size-4" />
                            </Button>
                          )}
                          {canAdjust && (
                            <Button
                              variant="outline"
                              size="icon"
                              title="Stock settings"
                              aria-label="Stock settings"
                              className="size-8 border-slate-200 text-slate-600 hover:bg-slate-100 hover:text-slate-700 dark:border-slate-500/40 dark:text-slate-300 dark:hover:bg-slate-500/10"
                              onClick={() => openDialog('settings', i)}
                            >
                              <Settings2 className="size-4" />
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
          <div className="border-t px-4 py-3">
            <Pager
              page={stock.data.page}
              pageSize={stock.data.page_size}
              total={stock.data.total}
              onPageChange={setPage}
            />
          </div>
        </div>
      )}

      <Dialog open={mode !== null} onOpenChange={(o) => !o && setMode(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {mode === 'add' && 'Add stock'}
              {mode === 'adjust' && 'Adjust stock'}
              {mode === 'count' && 'Stock count'}
              {mode === 'settings' && 'Stock settings'}
            </DialogTitle>
            <DialogDescription>
              {row
                ? `${row.part.part_number} — ${row.part.description}`
                : 'Select a part and branch to stock.'}
            </DialogDescription>
          </DialogHeader>

          <form
            onSubmit={(e) => {
              e.preventDefault()
              onSubmit()
            }}
            className="flex flex-col gap-4"
          >
            {mode === 'add' && (
              <div className="grid gap-4 sm:grid-cols-2">
                <FormField label="Part" htmlFor="add-part">
                  <Select
                    id="add-part"
                    value={fields.part_id}
                    onChange={(e) =>
                      setFields((f) => ({ ...f, part_id: e.target.value }))
                    }
                  >
                    <option value="">— select —</option>
                    {partOptions.data?.map((p) => (
                      <option key={p.id} value={p.id}>
                        {partLabel(p)}
                      </option>
                    ))}
                  </Select>
                </FormField>
                <FormField label="Branch" htmlFor="add-branch">
                  <Select
                    id="add-branch"
                    value={fields.branch_id}
                    onChange={(e) =>
                      setFields((f) => ({ ...f, branch_id: e.target.value }))
                    }
                  >
                    <option value="">— select —</option>
                    {branches.data?.map((b) => (
                      <option key={b.id} value={b.id}>
                        {b.code} — {b.name}
                      </option>
                    ))}
                  </Select>
                </FormField>
              </div>
            )}

            {(mode === 'add' || mode === 'adjust') && (
              <div className="grid gap-4 sm:grid-cols-2">
                <FormField
                  label={mode === 'add' ? 'Quantity to add' : 'Change (delta)'}
                  htmlFor="delta"
                  hint={
                    mode === 'adjust'
                      ? 'Positive adds, negative removes'
                      : undefined
                  }
                >
                  <Input
                    id="delta"
                    inputMode="numeric"
                    value={fields.delta}
                    onChange={(e) =>
                      setFields((f) => ({ ...f, delta: e.target.value }))
                    }
                  />
                </FormField>
                <FormField label="Type" htmlFor="mtype">
                  <Select
                    id="mtype"
                    value={fields.movement_type}
                    onChange={(e) =>
                      setFields((f) => ({
                        ...f,
                        movement_type: e.target.value,
                      }))
                    }
                  >
                    <option value="ADJUSTMENT">Adjustment</option>
                    <option value="DAMAGE">Damage (flag as damaged)</option>
                  </Select>
                </FormField>
              </div>
            )}

            {mode === 'count' && (
              <FormField
                label="Counted quantity"
                htmlFor="counted"
                hint={`On hand now: ${row?.qty_on_hand ?? 0}`}
              >
                <Input
                  id="counted"
                  inputMode="numeric"
                  value={fields.counted_qty}
                  onChange={(e) =>
                    setFields((f) => ({ ...f, counted_qty: e.target.value }))
                  }
                />
              </FormField>
            )}

            {mode === 'settings' && (
              <div className="grid gap-4 sm:grid-cols-2">
                <FormField label="Bin location" htmlFor="bin">
                  <Input
                    id="bin"
                    value={fields.bin_location}
                    onChange={(e) =>
                      setFields((f) => ({
                        ...f,
                        bin_location: e.target.value,
                      }))
                    }
                  />
                </FormField>
                <FormField label="Reorder level" htmlFor="reorder">
                  <Input
                    id="reorder"
                    inputMode="numeric"
                    value={fields.reorder_level}
                    onChange={(e) =>
                      setFields((f) => ({
                        ...f,
                        reorder_level: e.target.value,
                      }))
                    }
                  />
                </FormField>
              </div>
            )}

            {mode !== 'settings' && (
              <FormField
                label={mode === 'count' ? 'Reason (optional)' : 'Reason'}
                htmlFor="reason"
              >
                <Input
                  id="reason"
                  value={fields.reason}
                  onChange={(e) =>
                    setFields((f) => ({ ...f, reason: e.target.value }))
                  }
                  placeholder="e.g. opening stock, cycle count correction"
                />
              </FormField>
            )}

            <DialogFooter>
              <Button
                type="button"
                variant="ghost"
                onClick={() => setMode(null)}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={busy}>
                {busy ? 'Saving…' : 'Save'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  )
}
