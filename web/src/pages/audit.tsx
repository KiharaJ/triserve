import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import type { PaginatedResponse } from '@triserve/shared'
import { Pager } from '@/components/shared/pager'
import { Badge } from '@/components/ui/badge'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
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
import { formatDateTime } from '@/lib/format'
import type { AuditAction, AuditLogEntry, UserWire } from '@/lib/types'

function actionBadge(action: AuditAction) {
  switch (action) {
    case 'CREATE':
      return <Badge variant="success">CREATE</Badge>
    case 'DELETE':
    case 'REJECT':
      return <Badge variant="destructive">{action}</Badge>
    case 'APPROVE':
      return <Badge variant="success">APPROVE</Badge>
    default:
      return <Badge variant="secondary">{action}</Badge>
  }
}

function JsonBlock({ label, value }: { label: string; value: unknown }) {
  if (value === null || value === undefined) return null
  return (
    <div className="flex min-w-0 flex-1 flex-col gap-1">
      <span className="text-xs font-medium text-muted-foreground">
        {label}
      </span>
      <pre className="max-h-64 overflow-auto rounded-md border bg-muted/50 p-2 text-xs">
        {JSON.stringify(value, null, 2)}
      </pre>
    </div>
  )
}

/**
 * Audit log viewer (Task 0.7, DESIGN.md §7): the company's append-only
 * audit trail — filterable by entity type/id and date range, gated by
 * 'audit.read' (Super Admin, Branch Manager, Accountant). Row click shows
 * the before/after snapshots.
 */
export function AuditPage() {
  const { can } = useAuth()
  const [page, setPage] = useState(1)
  const [entityType, setEntityType] = useState('')
  const [entityId, setEntityId] = useState('')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [selected, setSelected] = useState<AuditLogEntry | null>(null)

  const entries = useQuery({
    queryKey: ['audit-log', page, entityType, entityId, from, to],
    queryFn: async () =>
      (
        await api.get<PaginatedResponse<AuditLogEntry>>('/audit-log', {
          params: {
            page,
            page_size: 25,
            ...(entityType ? { entity_type: entityType } : {}),
            ...(entityId ? { entity_id: entityId } : {}),
            ...(from ? { from } : {}),
            ...(to ? { to } : {}),
          },
        })
      ).data,
  })

  // Actor names need user.read (accountants lack it — they see raw ids).
  const canReadUsers = can('user.read')
  const users = useQuery({
    queryKey: ['users', 'all'],
    enabled: canReadUsers,
    queryFn: async () =>
      (
        await api.get<PaginatedResponse<UserWire>>('/users', {
          params: { page_size: 100 },
        })
      ).data.data,
  })
  const actorName = (id: string | null) => {
    if (!id) return 'system'
    return users.data?.find((u) => u.id === id)?.full_name ?? `${id.slice(0, 8)}…`
  }

  const resetPage = () => setPage(1)

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end gap-3">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="audit-entity-type">Entity type</Label>
          <Input
            id="audit-entity-type"
            placeholder="e.g. Branch"
            value={entityType}
            onChange={(e) => {
              setEntityType(e.target.value)
              resetPage()
            }}
            className="w-40"
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="audit-entity-id">Entity id</Label>
          <Input
            id="audit-entity-id"
            placeholder="UUID"
            value={entityId}
            onChange={(e) => {
              setEntityId(e.target.value)
              resetPage()
            }}
            className="w-72 font-mono"
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="audit-from">From</Label>
          <Input
            id="audit-from"
            type="date"
            value={from}
            onChange={(e) => {
              setFrom(e.target.value)
              resetPage()
            }}
            className="w-40"
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="audit-to">To</Label>
          <Input
            id="audit-to"
            type="date"
            value={to}
            onChange={(e) => {
              setTo(e.target.value)
              resetPage()
            }}
            className="w-40"
          />
        </div>
      </div>

      {entries.isPending && (
        <p className="text-sm text-muted-foreground">Loading…</p>
      )}
      {entries.isError && (
        <p className="text-sm text-destructive">
          {apiErrorMessage(entries.error)}
        </p>
      )}
      {entries.data && (
        <div className="rounded-xl border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>When</TableHead>
                <TableHead>Actor</TableHead>
                <TableHead>Action</TableHead>
                <TableHead>Entity</TableHead>
                <TableHead>Entity id</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {entries.data.data.length === 0 && (
                <TableRow>
                  <TableCell
                    colSpan={5}
                    className="text-center text-muted-foreground"
                  >
                    No audit entries match these filters.
                  </TableCell>
                </TableRow>
              )}
              {entries.data.data.map((e) => (
                <TableRow
                  key={e.id}
                  className="cursor-pointer"
                  onClick={() => setSelected(e)}
                >
                  <TableCell className="whitespace-nowrap">
                    {formatDateTime(e.at)}
                  </TableCell>
                  <TableCell>{actorName(e.actor_user_id)}</TableCell>
                  <TableCell>{actionBadge(e.action)}</TableCell>
                  <TableCell>{e.entity_type}</TableCell>
                  <TableCell
                    className="max-w-48 truncate font-mono text-xs text-muted-foreground"
                    title={e.entity_id}
                  >
                    {e.entity_id}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <div className="px-3 pb-3">
            <Pager
              page={entries.data.page}
              pageSize={entries.data.page_size}
              total={entries.data.total}
              onPageChange={setPage}
            />
          </div>
        </div>
      )}

      <Dialog
        open={selected !== null}
        onOpenChange={(open) => {
          if (!open) setSelected(null)
        }}
      >
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>
              {selected?.action} {selected?.entity_type}
            </DialogTitle>
            <DialogDescription>
              {formatDateTime(selected?.at)} · {actorName(selected?.actor_user_id ?? null)}
              {selected?.ip ? ` · ${selected.ip}` : ''}
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-3 sm:flex-row">
            <JsonBlock label="Before" value={selected?.before_json} />
            <JsonBlock label="After" value={selected?.after_json} />
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
