import { useQuery } from '@tanstack/react-query'
import { Bell } from 'lucide-react'
import { useState } from 'react'
import { Link } from 'react-router-dom'
import type { PaginatedResponse } from '@triserve/shared'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { api } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { formatDateTime } from '@/lib/format'
import type { JobWire } from '@/lib/types'

/**
 * Cross-page action-item bell, always in the topbar rather than buried on
 * one page: BOOKED jobs that need a human to do something before the
 * lifecycle can move on —
 *   - the assigned engineer acknowledging they physically have the device
 *     (BOOKED → RECEIVED), surfaced to THAT engineer wherever they are, and
 *   - a booked job with nobody assigned yet, surfaced to whoever can assign
 *     one ('job.assign' — branch managers / floor supervisors).
 *
 * Deliberately narrow (just these two, not every pending approval/QC/parts
 * queue in the system) — it answers "what needs ME, specifically" rather
 * than duplicating the Approvals inbox or the job board.
 */
export function AttentionPanel() {
  const { can, user } = useAuth()
  const [open, setOpen] = useState(false)
  const enabled = can('job.read')
  const canAssign = can('job.assign')

  const booked = useQuery({
    queryKey: ['jobs', 'attention', 'booked'],
    enabled,
    // A manager acting on this list expects it current, and the badge count
    // would otherwise go quietly stale between page navigations.
    refetchInterval: 60_000,
    queryFn: async () =>
      (
        await api.get<PaginatedResponse<JobWire>>('/jobs', {
          params: { state: 'BOOKED', page_size: 100 },
        })
      ).data.data,
  })

  if (!enabled) return null

  const needsAssignment = canAssign
    ? (booked.data ?? []).filter((j) => !j.assigned_engineer_id)
    : []
  const needsReceipt = (booked.data ?? []).filter(
    (j) => j.assigned_engineer_id === user?.id,
  )
  const total = needsAssignment.length + needsReceipt.length

  return (
    <>
      <Button
        variant="outline"
        size="icon"
        className="relative size-9"
        onClick={() => setOpen(true)}
        aria-label={
          total > 0 ? `${total} job${total === 1 ? '' : 's'} need your attention` : 'Needs your attention'
        }
        title="Needs your attention"
      >
        <Bell className="size-4" />
        {total > 0 && (
          <span className="absolute -top-1 -right-1 flex size-4 items-center justify-center rounded-full bg-destructive text-[10px] font-semibold text-destructive-foreground">
            {total > 9 ? '9+' : total}
          </span>
        )}
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Needs your attention</DialogTitle>
            <DialogDescription>
              Jobs waiting on you specifically, not the full queue.
            </DialogDescription>
          </DialogHeader>
          <div className="flex max-h-[60vh] flex-col gap-4 overflow-y-auto">
            {total === 0 && (
              <p className="text-sm text-muted-foreground">
                Nothing waiting on you right now.
              </p>
            )}
            {needsReceipt.length > 0 && (
              <div>
                <p className="mb-1.5 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
                  Assigned to you — acknowledge receipt
                </p>
                <div className="flex flex-col gap-1">
                  {needsReceipt.map((j) => (
                    <Link
                      key={j.id}
                      to={`/jobs/${j.id}`}
                      onClick={() => setOpen(false)}
                      className="flex items-center justify-between rounded-md border p-2 text-sm hover:bg-muted"
                    >
                      <span className="font-mono">{j.job_no}</span>
                      <span className="text-xs text-muted-foreground">
                        Booked {formatDateTime(j.received_at)}
                      </span>
                    </Link>
                  ))}
                </div>
              </div>
            )}
            {needsAssignment.length > 0 && (
              <div>
                <p className="mb-1.5 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
                  Needs an engineer assigned
                </p>
                <div className="flex flex-col gap-1">
                  {needsAssignment.map((j) => (
                    <Link
                      key={j.id}
                      to={`/jobs/${j.id}`}
                      onClick={() => setOpen(false)}
                      className="flex items-center justify-between rounded-md border p-2 text-sm hover:bg-muted"
                    >
                      <span className="font-mono">{j.job_no}</span>
                      <Badge variant="outline">{j.branch_code}</Badge>
                    </Link>
                  ))}
                </div>
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </>
  )
}
