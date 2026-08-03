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
import { Textarea } from '@/components/ui/textarea'
import { api, apiErrorMessage } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { formatDateTime, formatMoney } from '@/lib/format'
import type {
  BranchWire,
  DeviceCategory,
  SwapUnit,
  SwapUnitStatus,
} from '@/lib/types'

const STATUSES: SwapUnitStatus[] = [
  'IN_STOCK',
  'ALLOCATED',
  'ISSUED',
  'RETIRED',
]

const CATEGORIES: DeviceCategory[] = ['HHP', 'CE', 'AC', 'REF', 'OTHER']

function statusBadge(status: SwapUnitStatus) {
  switch (status) {
    case 'IN_STOCK':
      return <Badge variant="success">In stock</Badge>
    case 'ALLOCATED':
      return <Badge variant="warning">Allocated</Badge>
    case 'ISSUED':
      return <Badge variant="default">Issued</Badge>
    default:
      return <Badge variant="secondary">Retired</Badge>
  }
}

/**
 * Swap buffer stock (SCMS proposal Module 4, §5 step 4) — the pool of
 * replacement units held ready for a device written off as beyond economical
 * repair, so a BER decision does not leave the customer waiting on procurement.
 *
 * Units are ISSUED from the job's BER tab, not from here: issuing has to be
 * tied to the assessment that justified it. This screen is the stock ledger —
 * what is on the shelf, what is spoken for, and what has gone out.
 */
export function SwapStockPage() {
  const { can } = useAuth()
  const queryClient = useQueryClient()
  const [page, setPage] = useState(1)
  const [statusFilter, setStatusFilter] = useState('')
  const [categoryFilter, setCategoryFilter] = useState('')
  const [addOpen, setAddOpen] = useState(false)

  const canManage = can('swapstock.manage')

  const branches = useQuery({
    queryKey: ['branches', 'all'],
    queryFn: async () =>
      (
        await api.get<PaginatedResponse<BranchWire>>('/branches', {
          params: { page_size: 100 },
        })
      ).data.data,
  })

  const units = useQuery({
    queryKey: ['swap-stock', page, statusFilter, categoryFilter],
    queryFn: async () =>
      (
        await api.get<PaginatedResponse<SwapUnit>>('/swap-stock', {
          params: {
            page,
            page_size: 20,
            ...(statusFilter ? { status: statusFilter } : {}),
            ...(categoryFilter ? { category: categoryFilter } : {}),
          },
        })
      ).data,
  })

  const retire = useMutation({
    mutationFn: async (id: string) => api.delete(`/swap-stock/${id}`),
    onSuccess: async () => {
      toast.success('Unit retired')
      await queryClient.invalidateQueries({ queryKey: ['swap-stock'] })
    },
    onError: (e) => toast.error(apiErrorMessage(e)),
  })

  const branchName = (id: string) =>
    branches.data?.find((b) => b.id === id)?.code ?? '—'

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <Select
          value={statusFilter}
          onChange={(e) => {
            setStatusFilter(e.target.value)
            setPage(1)
          }}
          className="w-40"
          aria-label="Filter by status"
        >
          <option value="">All statuses</option>
          {STATUSES.map((s) => (
            <option key={s} value={s}>
              {s.replace('_', ' ')}
            </option>
          ))}
        </Select>
        <Select
          value={categoryFilter}
          onChange={(e) => {
            setCategoryFilter(e.target.value)
            setPage(1)
          }}
          className="w-36"
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
        {canManage && (
          <Button onClick={() => setAddOpen(true)}>Add a unit</Button>
        )}
      </div>

      {units.isPending && (
        <p className="text-sm text-muted-foreground">Loading…</p>
      )}
      {units.isError && (
        <p className="text-sm text-destructive">
          {apiErrorMessage(units.error)}
        </p>
      )}

      {units.data && (
        <div className="overflow-hidden rounded-xl border bg-card shadow-sm">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>IMEI / serial</TableHead>
                <TableHead>Model</TableHead>
                <TableHead>Class</TableHead>
                <TableHead>Branch</TableHead>
                <TableHead className="text-right">Cost</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Issued</TableHead>
                {canManage && <TableHead className="w-24" />}
              </TableRow>
            </TableHeader>
            <TableBody>
              {units.data.data.length === 0 && (
                <TableRow>
                  <TableCell
                    colSpan={canManage ? 8 : 7}
                    className="text-center text-muted-foreground"
                  >
                    No swap units
                  </TableCell>
                </TableRow>
              )}
              {units.data.data.map((u) => (
                <TableRow key={u.id}>
                  <TableCell className="font-mono text-sm">
                    {u.imei_serial}
                  </TableCell>
                  <TableCell>
                    {u.model_label ?? '—'}
                    {u.color && (
                      <span className="ml-1 text-xs text-muted-foreground">
                        {u.color}
                      </span>
                    )}
                  </TableCell>
                  <TableCell>{u.category}</TableCell>
                  <TableCell>{branchName(u.branch_id)}</TableCell>
                  <TableCell className="text-right tabular-nums">
                    {u.cost ? formatMoney(u.cost, u.currency ?? 'TZS') : '—'}
                  </TableCell>
                  <TableCell>{statusBadge(u.status)}</TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {u.issued_at ? formatDateTime(u.issued_at) : '—'}
                  </TableCell>
                  {canManage && (
                    <TableCell>
                      {u.status === 'IN_STOCK' && (
                        <Button
                          variant="ghost"
                          size="xs"
                          disabled={retire.isPending}
                          onClick={() => retire.mutate(u.id)}
                        >
                          Retire
                        </Button>
                      )}
                    </TableCell>
                  )}
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <Pager
            page={page}
            pageSize={20}
            total={units.data.total}
            onPageChange={setPage}
          />
        </div>
      )}

      {addOpen && (
        <AddUnitDialog
          branches={branches.data ?? []}
          onClose={() => setAddOpen(false)}
          onAdded={async () => {
            setAddOpen(false)
            await queryClient.invalidateQueries({ queryKey: ['swap-stock'] })
          }}
        />
      )}
    </div>
  )
}

function AddUnitDialog({
  branches,
  onClose,
  onAdded,
}: {
  branches: BranchWire[]
  onClose: () => void
  onAdded: () => void | Promise<void>
}) {
  const [branchId, setBranchId] = useState('')
  const [imei, setImei] = useState('')
  const [modelLabel, setModelLabel] = useState('')
  const [category, setCategory] = useState<DeviceCategory>('HHP')
  const [color, setColor] = useState('')
  const [cost, setCost] = useState('')
  const [notes, setNotes] = useState('')

  const add = useMutation({
    mutationFn: async () =>
      api.post('/swap-stock', {
        branch_id: branchId,
        imei_serial: imei.trim(),
        category,
        ...(modelLabel.trim() ? { model_label: modelLabel.trim() } : {}),
        ...(color.trim() ? { color: color.trim() } : {}),
        ...(cost.trim() ? { cost: cost.trim() } : {}),
        ...(notes.trim() ? { notes: notes.trim() } : {}),
      }),
    onSuccess: async () => {
      toast.success('Unit added to the swap buffer')
      await onAdded()
    },
    onError: (e) => toast.error(apiErrorMessage(e)),
  })

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add a swap unit</DialogTitle>
          <DialogDescription>
            A replacement handset held ready for a BER write-off.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <FormField label="Branch">
            <Select
              value={branchId}
              onChange={(e) => setBranchId(e.target.value)}
            >
              <option value="">Select…</option>
              {branches.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.code} — {b.name}
                </option>
              ))}
            </Select>
          </FormField>
          <FormField label="IMEI / serial">
            <Input
              className="font-mono"
              value={imei}
              onChange={(e) => setImei(e.target.value)}
            />
          </FormField>
          <FormField label="Model">
            <Input
              value={modelLabel}
              onChange={(e) => setModelLabel(e.target.value)}
              placeholder="e.g. Galaxy A06"
            />
          </FormField>
          <FormField label="Device class">
            <Select
              value={category}
              onChange={(e) => setCategory(e.target.value as DeviceCategory)}
            >
              {CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </Select>
          </FormField>
          <FormField label="Colour">
            <Input value={color} onChange={(e) => setColor(e.target.value)} />
          </FormField>
          <FormField
            label="Cost"
            hint="Minor units (senti) — digits only, no decimal point."
          >
            <Input
              inputMode="numeric"
              value={cost}
              onChange={(e) => setCost(e.target.value.replace(/\D/g, ''))}
            />
          </FormField>
          <FormField label="Notes">
            <Textarea
              rows={2}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
            />
          </FormField>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={!branchId || imei.trim().length < 3 || add.isPending}
            onClick={() => add.mutate()}
          >
            Add unit
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
