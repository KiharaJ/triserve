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
  BranchWire,
  PartUnitStatus,
  PartUnitWire,
  PartWire,
} from '@/lib/types'

const STATUSES: PartUnitStatus[] = [
  'IN_STOCK',
  'RESERVED',
  'INSTALLED',
  'RETURNED',
  'DAMAGED',
]

function statusBadge(status: PartUnitStatus) {
  switch (status) {
    case 'IN_STOCK':
      return <Badge variant="success">In stock</Badge>
    case 'RESERVED':
      return <Badge variant="warning">Reserved</Badge>
    case 'INSTALLED':
      return <Badge variant="default">Installed</Badge>
    case 'RETURNED':
      return <Badge variant="secondary">Returned</Badge>
    default:
      return <Badge variant="destructive">Damaged</Badge>
  }
}

/**
 * Serial units (Task 2.4, §4.4/E11): unit-level tracking for serialized parts —
 * register serials into stock, look one up by serial (recall / "which unit"),
 * and change its status/location.
 */
export function SerialUnitsPage() {
  const { can, user } = useAuth()
  const queryClient = useQueryClient()
  const [page, setPage] = useState(1)
  const [serial, setSerial] = useState('')
  const [statusFilter, setStatusFilter] = useState('')
  const [dialogOpen, setDialogOpen] = useState(false)
  const [regPart, setRegPart] = useState('')
  const [regBranch, setRegBranch] = useState('')
  const [regSerials, setRegSerials] = useState('')
  const [regWarranty, setRegWarranty] = useState('')
  const debouncedSerial = useDebouncedValue(serial, 350)

  const canManage = can('inventory.adjust')

  const branches = useQuery({
    queryKey: ['branches', 'all'],
    queryFn: async () =>
      (
        await api.get<PaginatedResponse<BranchWire>>('/branches', {
          params: { page_size: 100 },
        })
      ).data.data,
  })

  // Only serialized parts can hold units.
  const parts = useQuery({
    queryKey: ['parts', 'serialized'],
    enabled: canManage,
    queryFn: async () =>
      (
        await api.get<PaginatedResponse<PartWire>>('/parts', {
          params: { page_size: 100, active: true },
        })
      ).data.data.filter((p) => p.is_serialized),
  })

  const units = useQuery({
    queryKey: ['part-units', page, debouncedSerial, statusFilter],
    queryFn: async () =>
      (
        await api.get<PaginatedResponse<PartUnitWire>>('/part-units', {
          params: {
            page,
            page_size: 20,
            ...(debouncedSerial ? { serial: debouncedSerial } : {}),
            ...(statusFilter ? { status: statusFilter } : {}),
          },
        })
      ).data,
  })

  const register = useMutation({
    mutationFn: async () => {
      const serials = regSerials
        .split(/[\n,]/)
        .map((s) => s.trim())
        .filter(Boolean)
      return api.post(`/parts/${regPart}/units`, {
        branch_id: regBranch || undefined,
        serials,
        warranty_expiry: regWarranty || undefined,
      })
    },
    onSuccess: async () => {
      toast.success('Units registered')
      setDialogOpen(false)
      setRegSerials('')
      await queryClient.invalidateQueries({ queryKey: ['part-units'] })
    },
    onError: (e) => toast.error(apiErrorMessage(e)),
  })

  const setStatus = useMutation({
    mutationFn: async ({ id, status }: { id: string; status: string }) =>
      api.patch(`/part-units/${id}`, { status }),
    onSuccess: async () => {
      toast.success('Unit updated')
      await queryClient.invalidateQueries({ queryKey: ['part-units'] })
    },
    onError: (e) => toast.error(apiErrorMessage(e)),
  })

  function openRegister() {
    setRegPart('')
    setRegBranch(user?.scope === 'branch' ? '' : '')
    setRegSerials('')
    setRegWarranty('')
    setDialogOpen(true)
  }

  const regSerialCount = regSerials
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter(Boolean).length

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <Input
          placeholder="Look up a serial…"
          value={serial}
          onChange={(e) => {
            setSerial(e.target.value)
            setPage(1)
          }}
          className="max-w-xs"
        />
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
              {s}
            </option>
          ))}
        </Select>
        <div className="flex-1" />
        {canManage && <Button onClick={openRegister}>Register units</Button>}
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
        <div className="rounded-xl border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Serial</TableHead>
                <TableHead>Part</TableHead>
                <TableHead>Location</TableHead>
                <TableHead>Warranty</TableHead>
                <TableHead>Status</TableHead>
                {canManage && <TableHead className="w-40" />}
              </TableRow>
            </TableHeader>
            <TableBody>
              {units.data.data.length === 0 && (
                <TableRow>
                  <TableCell
                    colSpan={canManage ? 6 : 5}
                    className="text-center text-muted-foreground"
                  >
                    No serial units
                  </TableCell>
                </TableRow>
              )}
              {units.data.data.map((u) => (
                <TableRow key={u.id}>
                  <TableCell className="font-mono text-sm">
                    {u.serial_no}
                  </TableCell>
                  <TableCell className="text-sm">
                    {u.part.part_number}
                  </TableCell>
                  <TableCell>{u.branch_code}</TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {u.warranty_expiry ? formatDate(u.warranty_expiry) : '—'}
                  </TableCell>
                  <TableCell>{statusBadge(u.status)}</TableCell>
                  {canManage && (
                    <TableCell>
                      <Select
                        value={u.status}
                        aria-label="Change status"
                        disabled={setStatus.isPending}
                        onChange={(e) =>
                          setStatus.mutate({ id: u.id, status: e.target.value })
                        }
                      >
                        {STATUSES.map((s) => (
                          <option key={s} value={s}>
                            {s}
                          </option>
                        ))}
                      </Select>
                    </TableCell>
                  )}
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <div className="px-3 pb-3">
            <Pager
              page={units.data.page}
              pageSize={units.data.page_size}
              total={units.data.total}
              onPageChange={setPage}
            />
          </div>
        </div>
      )}

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Register serial units</DialogTitle>
            <DialogDescription>
              Only serial-tracked parts can hold units. Enter one serial per
              line (or comma-separated).
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <FormField label="Part" htmlFor="ru-part">
                <Select
                  id="ru-part"
                  value={regPart}
                  onChange={(e) => setRegPart(e.target.value)}
                >
                  <option value="">— select a serialized part —</option>
                  {parts.data?.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.part_number} — {p.description}
                    </option>
                  ))}
                </Select>
              </FormField>
              <FormField
                label="Location branch"
                htmlFor="ru-branch"
                hint="Defaults to your branch"
              >
                <Select
                  id="ru-branch"
                  value={regBranch}
                  onChange={(e) => setRegBranch(e.target.value)}
                >
                  <option value="">— your branch —</option>
                  {branches.data?.map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.code} — {b.name}
                    </option>
                  ))}
                </Select>
              </FormField>
            </div>
            <FormField
              label={`Serials${regSerialCount ? ` (${regSerialCount})` : ''}`}
              htmlFor="ru-serials"
            >
              <Textarea
                id="ru-serials"
                rows={5}
                value={regSerials}
                onChange={(e) => setRegSerials(e.target.value)}
                placeholder={'SN-001\nSN-002\nSN-003'}
              />
            </FormField>
            <FormField label="Warranty expiry (optional)" htmlFor="ru-warranty">
              <Input
                id="ru-warranty"
                type="date"
                value={regWarranty}
                onChange={(e) => setRegWarranty(e.target.value)}
              />
            </FormField>
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={() => setDialogOpen(false)}
            >
              Cancel
            </Button>
            <Button
              disabled={
                register.isPending || !regPart || regSerialCount === 0
              }
              onClick={() => register.mutate()}
            >
              {register.isPending ? 'Registering…' : 'Register'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
