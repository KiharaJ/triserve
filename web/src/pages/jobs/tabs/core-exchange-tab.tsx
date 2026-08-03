import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowLeftRight, MapPin, Printer } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
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
import type { CoreStatus, JobDetailWire, PickingTicket } from '@/lib/types'

/**
 * The closed-loop core exchange (SCMS proposal Module 3, §4).
 *
 * Three operations, in the order the warehouse performs them:
 *
 *   1. PICKING TICKET — "showing the specific physical Bin Location";
 *   2. ISSUE TO TECH  — the new part's serial is tagged to the repair ticket
 *                       ("New Part Serial Out");
 *   3. CORE RETURN    — the old component is scanned into the secure return
 *                       bin ("Old Part Serial In"). Until every consumed
 *                       core-exchange part has one, the job cannot reach QC.
 */
export function CoreExchangeTab({ job }: { job: JobDetailWire }) {
  const { can } = useAuth()
  const queryClient = useQueryClient()

  const ticket = useQuery({
    queryKey: ['picking-ticket', job.id],
    enabled: can('inventory.read'),
    queryFn: async () =>
      (await api.get<PickingTicket>(`/jobs/${job.id}/parts/picking-ticket`))
        .data,
  })

  const status = useQuery({
    queryKey: ['core-status', job.id],
    queryFn: async () =>
      (await api.get<CoreStatus>(`/jobs/${job.id}/parts/core-status`)).data,
  })

  function refresh() {
    void queryClient.invalidateQueries({ queryKey: ['picking-ticket', job.id] })
    void queryClient.invalidateQueries({ queryKey: ['core-status', job.id] })
    void queryClient.invalidateQueries({ queryKey: ['job-parts', job.id] })
  }

  return (
    <div className="flex flex-col gap-4">
      {ticket.data && ticket.data.lines.length > 0 && (
        <PickingCard
          job={job}
          ticket={ticket.data}
          canIssue={can('inventory.issue')}
          onIssued={refresh}
        />
      )}
      {status.data && (
        <CoreCard
          job={job}
          status={status.data}
          canReturn={can('inventory.core.return')}
          onReturned={refresh}
        />
      )}
      {ticket.data?.lines.length === 0 && status.data?.lines.length === 0 && (
        <p className="text-sm text-muted-foreground">
          No parts are committed to this job yet. Reserve them on the Parts tab
          first.
        </p>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------

function PickingCard({
  job,
  ticket,
  canIssue,
  onIssued,
}: {
  job: JobDetailWire
  ticket: PickingTicket
  canIssue: boolean
  onIssued: () => void
}) {
  const [serials, setSerials] = useState<Record<string, string>>({})

  const issue = useMutation({
    mutationFn: async (lineId: string) =>
      (
        await api.post(`/jobs/${job.id}/parts/${lineId}/issue`, {
          serial_no: serials[lineId]?.trim() || undefined,
        })
      ).data,
    onSuccess: () => {
      toast.success('Issued to the bench')
      onIssued()
    },
    onError: (e) => toast.error(apiErrorMessage(e)),
  })

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between">
        <CardTitle className="flex items-center gap-2">
          <MapPin className="size-4" /> Picking ticket — {ticket.job_no}
        </CardTitle>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => window.print()}
        >
          <Printer className="size-3.5" /> Print
        </Button>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Part</TableHead>
              <TableHead>Bin</TableHead>
              <TableHead className="text-right">Qty</TableHead>
              <TableHead>New serial</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {ticket.lines.map((line) => (
              <TableRow key={line.line_id}>
                <TableCell>
                  <span className="font-medium">{line.part_number}</span>
                  <span className="block text-xs text-muted-foreground">
                    {line.description}
                  </span>
                  {line.core_required && (
                    <Badge variant="warning" className="mt-1">
                      core exchange
                    </Badge>
                  )}
                </TableCell>
                <TableCell>
                  <span className="font-mono text-sm">
                    {line.bin_location ?? '—'}
                  </span>
                  {line.bin_moved && (
                    <span className="block text-xs text-amber-600 dark:text-amber-400">
                      moved since reservation
                    </span>
                  )}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {line.qty}
                </TableCell>
                <TableCell>
                  <Input
                    className="h-8 w-40"
                    placeholder={
                      line.is_serialized ? 'Scan serial (required)' : 'Optional'
                    }
                    value={serials[line.line_id] ?? ''}
                    disabled={!canIssue}
                    onChange={(e) =>
                      setSerials((s) => ({
                        ...s,
                        [line.line_id]: e.target.value,
                      }))
                    }
                  />
                </TableCell>
                <TableCell>
                  {canIssue && (
                    <Button
                      type="button"
                      size="sm"
                      disabled={
                        issue.isPending ||
                        (line.is_serialized && !serials[line.line_id]?.trim())
                      }
                      onClick={() => issue.mutate(line.line_id)}
                    >
                      Issue
                    </Button>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  )
}

// ---------------------------------------------------------------------------

function CoreCard({
  job,
  status,
  canReturn,
  onReturned,
}: {
  job: JobDetailWire
  status: CoreStatus
  canReturn: boolean
  onReturned: () => void
}) {
  const [serials, setSerials] = useState<Record<string, string>>({})
  const [bins, setBins] = useState<Record<string, string>>({})

  const returnCore = useMutation({
    mutationFn: async (lineId: string) =>
      (
        await api.post(`/jobs/${job.id}/parts/${lineId}/core-return`, {
          core_serial_no: serials[lineId]?.trim(),
          bin_location: bins[lineId]?.trim() || undefined,
        })
      ).data,
    onSuccess: () => {
      toast.success('Defective core booked into the return bin')
      onReturned()
    },
    onError: (e) => toast.error(apiErrorMessage(e)),
  })

  if (status.lines.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <ArrowLeftRight className="size-4" /> Core exchange
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            No core-exchange parts on this job — nothing is owed back to the
            manufacturer.
          </p>
        </CardContent>
      </Card>
    )
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2">
          <ArrowLeftRight className="size-4" /> Core exchange
          {status.clear ? (
            <Badge variant="success">All cores returned</Badge>
          ) : (
            <Badge variant="destructive">
              {status.outstanding_count} pending defective return
            </Badge>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {!status.clear && (
          <p className="rounded-lg border border-amber-500/30 bg-amber-500/[0.06] p-3 text-sm">
            This job cannot move to quality check until every old component is
            physically in the secure return bin and its serial is scanned in.
          </p>
        )}
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Part</TableHead>
              <TableHead>Serial out (new)</TableHead>
              <TableHead>Serial in (old)</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {status.lines.map((line) => (
              <TableRow key={line.line_id}>
                <TableCell>
                  <span className="font-medium">{line.part_number}</span>
                  <span className="block text-xs text-muted-foreground">
                    {line.description} · {line.status.toLowerCase()}
                  </span>
                </TableCell>
                <TableCell className="font-mono text-xs">
                  {line.new_serial_no ?? '—'}
                </TableCell>
                <TableCell>
                  {line.core_returned_at ? (
                    <>
                      <span className="font-mono text-xs">
                        {line.core_serial_no}
                      </span>
                      <span className="block text-xs text-muted-foreground">
                        {formatDateTime(line.core_returned_at)}
                      </span>
                    </>
                  ) : canReturn && line.outstanding ? (
                    <div className="flex gap-1">
                      <Input
                        className="h-8 w-36"
                        placeholder="Scan old serial"
                        value={serials[line.line_id] ?? ''}
                        onChange={(e) =>
                          setSerials((s) => ({
                            ...s,
                            [line.line_id]: e.target.value,
                          }))
                        }
                      />
                      <Input
                        className="h-8 w-24"
                        placeholder="Bin"
                        value={bins[line.line_id] ?? ''}
                        onChange={(e) =>
                          setBins((b) => ({
                            ...b,
                            [line.line_id]: e.target.value,
                          }))
                        }
                      />
                    </div>
                  ) : (
                    <span className="text-xs text-muted-foreground">
                      {/* A core is only owed once the replacement is FITTED —
                          a reservation the technician never used has no old
                          unit to give back. */}
                      Not yet fitted
                    </span>
                  )}
                </TableCell>
                <TableCell>
                  {canReturn && line.outstanding && !line.core_returned_at && (
                    <Button
                      type="button"
                      size="sm"
                      disabled={
                        returnCore.isPending ||
                        (serials[line.line_id]?.trim().length ?? 0) < 3
                      }
                      onClick={() => returnCore.mutate(line.line_id)}
                    >
                      Book in
                    </Button>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  )
}
