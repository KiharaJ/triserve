import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { toast } from 'sonner'
import type { PaginatedResponse } from '@triserve/shared'
import { Pager } from '@/components/shared/pager'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
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
import { formatDateTime } from '@/lib/format'
import { useDebouncedValue } from '@/lib/use-debounced-value'
import type {
  NotificationChannel,
  NotificationRow,
  NotificationStatus,
} from '@/lib/types'

const CHANNELS: NotificationChannel[] = ['SMS', 'EMAIL', 'WHATSAPP', 'IN_APP']
const STATUSES: NotificationStatus[] = [
  'QUEUED',
  'SENDING',
  'SENT',
  'FAILED',
  'CANCELLED',
]

function statusBadge(status: NotificationStatus) {
  switch (status) {
    case 'SENT':
      return <Badge variant="success">Sent</Badge>
    case 'QUEUED':
      return <Badge variant="warning">Queued</Badge>
    case 'SENDING':
      return <Badge variant="default">Sending</Badge>
    case 'FAILED':
      return <Badge variant="destructive">Failed</Badge>
    default:
      return <Badge variant="secondary">Cancelled</Badge>
  }
}

/**
 * Communications log (SCMS proposal Module 7, §8) — every message the system
 * has sent a customer, and what became of it.
 *
 * Messages go out through an OUTBOX rather than inline with the request that
 * triggered them, so this is also the operational view of that queue: what is
 * waiting, what failed and why, and a manual drain for when a gateway outage
 * has just been fixed and nobody wants to wait for the next poll.
 *
 * Note the bodies are shown but PINs are not: a collection OTP is stored
 * hashed and its payload is masked, so this screen can never be used to look
 * up a code and collect somebody else's device.
 */
export function CommsLogPage() {
  const { can } = useAuth()
  const queryClient = useQueryClient()
  const [page, setPage] = useState(1)
  const [q, setQ] = useState('')
  const [channel, setChannel] = useState('')
  const [status, setStatus] = useState('')
  const debouncedQ = useDebouncedValue(q, 350)

  const canManage = can('notification.manage')

  const list = useQuery({
    queryKey: ['notifications', page, debouncedQ, channel, status],
    queryFn: async () =>
      (
        await api.get<PaginatedResponse<NotificationRow>>('/notifications', {
          params: {
            page,
            page_size: 25,
            ...(debouncedQ ? { q: debouncedQ } : {}),
            ...(channel ? { channel } : {}),
            ...(status ? { status } : {}),
          },
        })
      ).data,
  })

  const refresh = () =>
    queryClient.invalidateQueries({ queryKey: ['notifications'] })

  const drain = useMutation({
    mutationFn: async () =>
      (
        await api.post<{ claimed: number; sent: number; failed: number }>(
          '/notifications/drain',
        )
      ).data,
    onSuccess: async (r) => {
      toast.success(`Drained — ${r.sent} sent, ${r.failed} failed`)
      await refresh()
    },
    onError: (e) => toast.error(apiErrorMessage(e)),
  })

  const retry = useMutation({
    mutationFn: async (id: string) => api.post(`/notifications/${id}/retry`),
    onSuccess: async () => {
      toast.success('Re-queued')
      await refresh()
    },
    onError: (e) => toast.error(apiErrorMessage(e)),
  })

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <Input
          placeholder="Search the message or recipient…"
          value={q}
          onChange={(e) => {
            setQ(e.target.value)
            setPage(1)
          }}
          className="max-w-xs"
        />
        <Select
          value={channel}
          onChange={(e) => {
            setChannel(e.target.value)
            setPage(1)
          }}
          className="w-36"
          aria-label="Filter by channel"
        >
          <option value="">All channels</option>
          {CHANNELS.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </Select>
        <Select
          value={status}
          onChange={(e) => {
            setStatus(e.target.value)
            setPage(1)
          }}
          className="w-36"
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
        {canManage && (
          <Button
            variant="outline"
            disabled={drain.isPending}
            onClick={() => drain.mutate()}
          >
            Send queued now
          </Button>
        )}
      </div>

      {list.isPending && (
        <p className="text-sm text-muted-foreground">Loading…</p>
      )}
      {list.isError && (
        <p className="text-sm text-destructive">{apiErrorMessage(list.error)}</p>
      )}

      {list.data && (
        <div className="overflow-hidden rounded-xl border bg-card shadow-sm">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>When</TableHead>
                <TableHead>Event</TableHead>
                <TableHead>Channel</TableHead>
                <TableHead>To</TableHead>
                <TableHead>Message</TableHead>
                <TableHead>Status</TableHead>
                {canManage && <TableHead className="w-24" />}
              </TableRow>
            </TableHeader>
            <TableBody>
              {list.data.data.length === 0 && (
                <TableRow>
                  <TableCell
                    colSpan={canManage ? 7 : 6}
                    className="text-center text-muted-foreground"
                  >
                    Nothing has been sent yet
                  </TableCell>
                </TableRow>
              )}
              {list.data.data.map((n) => (
                <TableRow key={n.id}>
                  <TableCell className="text-sm whitespace-nowrap text-muted-foreground">
                    {formatDateTime(n.sent_at ?? n.created_at)}
                  </TableCell>
                  <TableCell className="text-sm">{n.event_code}</TableCell>
                  <TableCell className="text-sm">{n.channel}</TableCell>
                  <TableCell className="font-mono text-sm">
                    {n.to_address}
                  </TableCell>
                  <TableCell className="max-w-md text-sm">
                    <span className="line-clamp-2" title={n.body}>
                      {n.body}
                    </span>
                    {n.last_error && (
                      <span className="mt-1 block text-xs text-destructive">
                        {n.last_error}
                      </span>
                    )}
                  </TableCell>
                  <TableCell>
                    {statusBadge(n.status)}
                    {n.attempts > 1 && (
                      <span className="ml-1 text-xs text-muted-foreground">
                        ×{n.attempts}
                      </span>
                    )}
                  </TableCell>
                  {canManage && (
                    <TableCell>
                      {n.status === 'FAILED' && (
                        <Button
                          variant="ghost"
                          size="xs"
                          disabled={retry.isPending}
                          onClick={() => retry.mutate(n.id)}
                        >
                          Retry
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
            pageSize={25}
            total={list.data.total}
            onPageChange={setPage}
          />
        </div>
      )}
    </div>
  )
}
