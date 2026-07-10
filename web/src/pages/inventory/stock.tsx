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
        >
          Low stock only
        </Button>
        <div className="flex-1" />
        {canAdjust && (
          <Button onClick={() => openDialog('add', null)}>Add stock</Button>
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
        <div className="rounded-xl border">
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
                {(canAdjust || canCount) && <TableHead className="w-52" />}
              </TableRow>
            </TableHeader>
            <TableBody>
              {stock.data.data.length === 0 && (
                <TableRow>
                  <TableCell
                    colSpan={8}
                    className="text-center text-muted-foreground"
                  >
                    No stock rows
                  </TableCell>
                </TableRow>
              )}
              {stock.data.data.map((i) => (
                <TableRow key={i.id}>
                  <TableCell>
                    <div className="flex flex-col">
                      <span className="font-mono text-sm">
                        {i.part.part_number}
                      </span>
                      <span className="text-xs text-muted-foreground">
                        {i.part.description}
                      </span>
                    </div>
                  </TableCell>
                  <TableCell className="font-mono text-sm">
                    {i.bin_location ?? '—'}
                  </TableCell>
                  <TableCell className="text-right">{i.qty_on_hand}</TableCell>
                  <TableCell className="text-right text-muted-foreground">
                    {i.qty_reserved}
                  </TableCell>
                  <TableCell className="text-right text-muted-foreground">
                    {i.qty_damaged}
                  </TableCell>
                  <TableCell className="text-right font-semibold">
                    <span className="inline-flex items-center gap-2">
                      {i.qty_available}
                      {i.low_stock && <Badge variant="warning">Low</Badge>}
                    </span>
                  </TableCell>
                  <TableCell className="text-right text-muted-foreground">
                    {i.reorder_level}
                  </TableCell>
                  {(canAdjust || canCount) && (
                    <TableCell>
                      <div className="flex gap-1">
                        {canAdjust && (
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => openDialog('adjust', i)}
                          >
                            Adjust
                          </Button>
                        )}
                        {canCount && (
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => openDialog('count', i)}
                          >
                            Count
                          </Button>
                        )}
                        {canAdjust && (
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => openDialog('settings', i)}
                          >
                            Settings
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
