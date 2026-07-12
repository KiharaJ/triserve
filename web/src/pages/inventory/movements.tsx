import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import type { PaginatedResponse } from '@triserve/shared'
import { Pager } from '@/components/shared/pager'
import { Badge } from '@/components/ui/badge'
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
import { formatDateTime } from '@/lib/format'
import { useDebouncedValue } from '@/lib/use-debounced-value'
import type {
  BranchWire,
  StockMovementType,
  StockMovementWire,
} from '@/lib/types'

const MOVEMENT_TYPES: StockMovementType[] = [
  'RECEIPT',
  'CONSUMPTION',
  'TRANSFER_OUT',
  'TRANSFER_IN',
  'ADJUSTMENT',
  'SALE',
  'RETURN',
  'SUPPLIER_RETURN',
  'RESERVE',
  'UNRESERVE',
  'DAMAGE',
]

/** Inbound movement types render green; outbound render red. */
const INBOUND = new Set<StockMovementType>([
  'RECEIPT',
  'TRANSFER_IN',
  'RETURN',
  'UNRESERVE',
])

/**
 * Stock movements (Task 2.1, §4.4): the append-only ledger — the source of
 * truth behind every bucket. Read-only; every row records who moved what,
 * when, why, and the source document.
 */
export function MovementsPage() {
  const [page, setPage] = useState(1)
  const [q, setQ] = useState('')
  const [branchFilter, setBranchFilter] = useState('')
  const [typeFilter, setTypeFilter] = useState('')
  const debouncedQ = useDebouncedValue(q, 350)

  const branches = useQuery({
    queryKey: ['branches', 'all'],
    queryFn: async () =>
      (
        await api.get<PaginatedResponse<BranchWire>>('/branches', {
          params: { page_size: 100 },
        })
      ).data.data,
  })

  const movements = useQuery({
    queryKey: ['movements', page, debouncedQ, branchFilter, typeFilter],
    queryFn: async () =>
      (
        await api.get<PaginatedResponse<StockMovementWire>>(
          '/inventory/movements',
          {
            params: {
              page,
              page_size: 20,
              ...(branchFilter ? { branch_id: branchFilter } : {}),
              ...(typeFilter ? { type: typeFilter } : {}),
            },
          },
        )
      ).data,
  })

  // Client-side part-number filter over the current page (the ledger endpoint
  // filters by branch/type/date; part text is a convenience narrowing).
  const rows = (movements.data?.data ?? []).filter((m) =>
    debouncedQ
      ? (m.part?.part_number ?? '')
          .toLowerCase()
          .includes(debouncedQ.toLowerCase())
      : true,
  )

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <Input
          placeholder="Filter this page by part number…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
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
        <Select
          value={typeFilter}
          onChange={(e) => {
            setTypeFilter(e.target.value)
            setPage(1)
          }}
          className="w-48"
          aria-label="Filter by movement type"
        >
          <option value="">All types</option>
          {MOVEMENT_TYPES.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </Select>
      </div>

      {movements.isPending && (
        <p className="text-sm text-muted-foreground">Loading…</p>
      )}
      {movements.isError && (
        <p className="text-sm text-destructive">
          {apiErrorMessage(movements.error)}
        </p>
      )}
      {movements.data && (
        <div className="overflow-hidden rounded-xl border bg-card shadow-sm">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>When</TableHead>
                <TableHead>Part</TableHead>
                <TableHead>Type</TableHead>
                <TableHead className="text-right">Qty</TableHead>
                <TableHead>Ref</TableHead>
                <TableHead>Reason</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.length === 0 && (
                <TableRow>
                  <TableCell
                    colSpan={6}
                    className="text-center text-muted-foreground"
                  >
                    No movements
                  </TableCell>
                </TableRow>
              )}
              {rows.map((m) => (
                <TableRow key={m.id}>
                  <TableCell className="whitespace-nowrap text-sm text-muted-foreground">
                    {formatDateTime(m.moved_at)}
                  </TableCell>
                  <TableCell className="font-mono text-sm">
                    {m.part?.part_number ?? m.part_id.slice(0, 8)}
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline">{m.movement_type}</Badge>
                  </TableCell>
                  <TableCell
                    className={`text-right font-semibold ${
                      INBOUND.has(m.movement_type)
                        ? 'text-emerald-600 dark:text-emerald-400'
                        : m.qty < 0
                          ? 'text-destructive'
                          : ''
                    }`}
                  >
                    {m.qty > 0 ? `+${m.qty}` : m.qty}
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {m.ref_type ?? '—'}
                  </TableCell>
                  <TableCell className="max-w-xs truncate text-sm text-muted-foreground">
                    {m.reason ?? '—'}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <div className="px-3 pb-3">
            <Pager
              page={movements.data.page}
              pageSize={movements.data.page_size}
              total={movements.data.total}
              onPageChange={setPage}
            />
          </div>
        </div>
      )}
    </div>
  )
}
