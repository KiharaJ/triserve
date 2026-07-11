import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { toast } from 'sonner'
import type { PaginatedResponse } from '@triserve/shared'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
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
import type {
  BranchWire,
  ReorderGroup,
  ReorderSuggestions,
} from '@/lib/types'

/**
 * Reorder suggestions (Task 2.9, §4.4b): parts at/below reorder level for a
 * branch, grouped by preferred supplier with a suggested quantity, each group
 * convertible to a draft purchase order in one click.
 */
export function ReorderPage() {
  const { can, user } = useAuth()
  const queryClient = useQueryClient()
  const [branchId, setBranchId] = useState('')
  // Editable suggested quantities, keyed by part id.
  const [qty, setQty] = useState<Record<string, string>>({})

  const canCreate = can('po.create')

  const branches = useQuery({
    queryKey: ['branches', 'all'],
    enabled: user?.scope === 'group',
    queryFn: async () =>
      (
        await api.get<PaginatedResponse<BranchWire>>('/branches', {
          params: { page_size: 100 },
        })
      ).data.data,
  })

  const suggestions = useQuery({
    queryKey: ['reorder', branchId],
    queryFn: async () =>
      (
        await api.get<ReorderSuggestions>('/reorder-suggestions', {
          params: branchId ? { branch_id: branchId } : {},
        })
      ).data,
  })

  const createPo = useMutation({
    mutationFn: async (group: ReorderGroup) => {
      const branch = suggestions.data?.branch_id
      return api.post('/purchase-orders', {
        supplier_id: group.supplier_id,
        branch_id: branch,
        lines: group.items.map((i) => ({
          part_id: i.part_id,
          qty_ordered: Number(qty[i.part_id] ?? i.suggested_qty),
          unit_cost: i.unit_cost_usd ?? '0',
        })),
      })
    },
    onSuccess: async () => {
      toast.success('Draft purchase order created')
      await queryClient.invalidateQueries({ queryKey: ['purchase-orders'] })
    },
    onError: (e) => toast.error(apiErrorMessage(e)),
  })

  const data = suggestions.data

  return (
    <div className="flex flex-col gap-4">
      {user?.scope === 'group' && (
        <div className="flex items-center gap-2">
          <Select
            value={branchId}
            onChange={(e) => setBranchId(e.target.value)}
            className="w-56"
            aria-label="Branch"
          >
            <option value="">Select a branch…</option>
            {branches.data?.map((b) => (
              <option key={b.id} value={b.id}>
                {b.code} — {b.name}
              </option>
            ))}
          </Select>
        </div>
      )}

      {suggestions.isPending && (
        <p className="text-sm text-muted-foreground">Loading…</p>
      )}
      {suggestions.isError && (
        <p className="text-sm text-destructive">
          {apiErrorMessage(suggestions.error)}
        </p>
      )}
      {data && data.groups.length === 0 && (
        <p className="text-sm text-muted-foreground">
          Nothing to reorder at {data.branch_code} — all stock is above its
          reorder level.
        </p>
      )}

      {data?.groups.map((group) => (
        <Card key={group.supplier_id ?? '__none__'}>
          <CardHeader className="flex-row items-center justify-between">
            <CardTitle className="text-base">
              {group.supplier_name ?? 'No preferred supplier'}
              {group.currency && (
                <Badge variant="outline" className="ml-2">
                  {group.currency}
                </Badge>
              )}
            </CardTitle>
            {canCreate && group.supplier_id && (
              <Button
                size="sm"
                disabled={createPo.isPending}
                onClick={() => createPo.mutate(group)}
              >
                Create purchase order
              </Button>
            )}
          </CardHeader>
          <CardContent>
            {!group.supplier_id && (
              <p className="mb-2 text-xs text-muted-foreground">
                Set a preferred supplier on these parts to order them.
              </p>
            )}
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Part</TableHead>
                  <TableHead className="text-right">Available</TableHead>
                  <TableHead className="text-right">Reorder level</TableHead>
                  <TableHead className="text-right">Order qty</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {group.items.map((i) => (
                  <TableRow key={i.part_id}>
                    <TableCell>
                      <div className="flex flex-col">
                        <span className="font-mono text-sm">
                          {i.part_number}
                        </span>
                        <span className="text-xs text-muted-foreground">
                          {i.description}
                        </span>
                      </div>
                    </TableCell>
                    <TableCell className="text-right">
                      <Badge variant="warning">{i.available}</Badge>
                    </TableCell>
                    <TableCell className="text-right text-muted-foreground">
                      {i.reorder_level}
                    </TableCell>
                    <TableCell className="text-right">
                      <Input
                        inputMode="numeric"
                        className="ml-auto w-20 text-right"
                        aria-label="Order quantity"
                        value={qty[i.part_id] ?? String(i.suggested_qty)}
                        onChange={(e) =>
                          setQty((q) => ({
                            ...q,
                            [i.part_id]: e.target.value,
                          }))
                        }
                      />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      ))}
    </div>
  )
}
