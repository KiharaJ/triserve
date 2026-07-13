import { useQuery } from '@tanstack/react-query'
import { Clock, Wrench } from 'lucide-react'
import { useState } from 'react'
import { Badge } from '@/components/ui/badge'
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
import type { OperationsReportWire } from '@/lib/types'

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
function monthLabel(ym: string): string {
  const [, m] = ym.split('-')
  return MONTHS[Number(m) - 1] ?? ym
}

function Bars({
  rows,
  color = 'bg-primary',
}: {
  rows: { label: string; value: number }[]
  color?: string
}) {
  const max = Math.max(1, ...rows.map((r) => r.value))
  return (
    <div className="space-y-2.5">
      {rows.map((r) => (
        <div key={r.label} className="flex flex-col gap-1">
          <div className="flex items-center justify-between text-sm">
            <span className="truncate">{r.label}</span>
            <span className="tabular-nums text-muted-foreground">{r.value.toLocaleString()}</span>
          </div>
          <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
            <div
              className={`h-full rounded-full ${color}`}
              style={{ width: `${Math.max(2, Math.round((r.value / max) * 100))}%` }}
            />
          </div>
        </div>
      ))}
    </div>
  )
}

/**
 * Operations report (Phase 5 / E15 + E5) — repair-shop BI: intake trend, state
 * mix, top device models, per-branch load, and technician performance. Live off
 * the jobs pipeline; gated by job.read.
 */
export function OperationsPage() {
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')

  const report = useQuery({
    queryKey: ['operations-report', from, to],
    queryFn: async () =>
      (
        await api.get<OperationsReportWire>('/reports/operations', {
          params: { ...(from ? { from } : {}), ...(to ? { to } : {}) },
        })
      ).data,
  })
  const d = report.data
  const activeStates = (d?.by_state ?? []).filter((s) => !s.is_terminal && s.count > 0)
  const maxIntake = Math.max(1, ...(d?.intake_by_month ?? []).map((m) => m.count))

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex-1" />
        <label className="flex items-center gap-1.5 text-sm text-muted-foreground">
          From
          <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="w-40" />
        </label>
        <label className="flex items-center gap-1.5 text-sm text-muted-foreground">
          To
          <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="w-40" />
        </label>
      </div>

      {report.isPending && <p className="text-sm text-muted-foreground">Loading…</p>}
      {report.isError && (
        <p className="text-sm text-destructive">{apiErrorMessage(report.error)}</p>
      )}

      {d && (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
            <Card className="gap-2">
              <CardContent className="flex flex-col gap-1.5">
                <div className="flex items-center justify-between">
                  <span className="text-sm text-muted-foreground">Total jobs</span>
                  <span className="flex size-8 items-center justify-center rounded-lg bg-blue-500/15 text-blue-600 dark:text-blue-400">
                    <Wrench className="size-4" />
                  </span>
                </div>
                <div className="text-2xl font-semibold tabular-nums">
                  {d.totals.total_jobs.toLocaleString()}
                </div>
                <div className="text-xs text-muted-foreground">{d.totals.active_jobs.toLocaleString()} active</div>
              </CardContent>
            </Card>
            <Card className="gap-2">
              <CardContent className="flex flex-col gap-1.5">
                <div className="flex items-center justify-between">
                  <span className="text-sm text-muted-foreground">Avg turnaround</span>
                  <span className="flex size-8 items-center justify-center rounded-lg bg-emerald-500/15 text-emerald-600 dark:text-emerald-400">
                    <Clock className="size-4" />
                  </span>
                </div>
                <div className="text-2xl font-semibold tabular-nums">
                  {d.totals.avg_turnaround_hours !== null
                    ? `${d.totals.avg_turnaround_hours}h`
                    : '—'}
                </div>
                <div className="text-xs text-muted-foreground">Received → dispatched</div>
              </CardContent>
            </Card>
            <Card className="gap-2">
              <CardContent className="flex flex-col gap-1.5">
                <div className="flex items-center justify-between">
                  <span className="text-sm text-muted-foreground">Branches</span>
                </div>
                <div className="text-2xl font-semibold tabular-nums">{d.by_branch.length}</div>
                <div className="text-xs text-muted-foreground">
                  {d.by_branch
                    .slice(0, 3)
                    .map((b) => `${b.code} ${b.count}`)
                    .join(' · ')}
                </div>
              </CardContent>
            </Card>
          </div>

          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Intake · last 12 months</CardTitle>
              </CardHeader>
              <CardContent>
                {d.intake_by_month.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No jobs in range.</p>
                ) : (
                  <div className="flex h-40 items-end gap-2">
                    {d.intake_by_month.map((m) => (
                      <div key={m.month} className="flex h-full flex-1 flex-col items-center justify-end gap-1">
                        <div className="flex w-full flex-1 items-end">
                          <div
                            className="w-full rounded-t bg-primary/80"
                            style={{ height: `${Math.max(2, Math.round((m.count / maxIntake) * 100))}%` }}
                            title={`${monthLabel(m.month)}: ${m.count}`}
                          />
                        </div>
                        <span className="text-[10px] text-muted-foreground">{monthLabel(m.month)}</span>
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="text-base">Top device models</CardTitle>
              </CardHeader>
              <CardContent>
                {d.top_models.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No devices in range.</p>
                ) : (
                  <Bars
                    rows={d.top_models.map((m) => ({ label: m.model, value: m.count }))}
                    color="bg-violet-500"
                  />
                )}
              </CardContent>
            </Card>
          </div>

          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Open jobs by stage</CardTitle>
              </CardHeader>
              <CardContent>
                {activeStates.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No open jobs.</p>
                ) : (
                  <Bars
                    rows={activeStates.map((s) => ({ label: s.label, value: s.count }))}
                    color="bg-sky-500"
                  />
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="text-base">Load by branch</CardTitle>
              </CardHeader>
              <CardContent>
                {d.by_branch.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No jobs.</p>
                ) : (
                  <Bars
                    rows={d.by_branch.map((b) => ({ label: b.name, value: b.count }))}
                    color="bg-emerald-500"
                  />
                )}
              </CardContent>
            </Card>
          </div>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Technician performance</CardTitle>
            </CardHeader>
            <CardContent>
              {d.technicians.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  No jobs assigned to technicians in this range. Assign engineers on the job
                  board to populate this.
                </p>
              ) : (
                <div className="overflow-hidden rounded-lg border">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Technician</TableHead>
                        <TableHead className="text-right">Assigned</TableHead>
                        <TableHead className="text-right">Completed</TableHead>
                        <TableHead className="text-right">Active</TableHead>
                        <TableHead className="text-right">Avg turnaround</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {d.technicians.map((t) => (
                        <TableRow key={t.engineer_id}>
                          <TableCell className="flex items-center gap-2">
                            <Badge variant="outline">
                              {t.initials ?? t.name.slice(0, 2).toUpperCase()}
                            </Badge>
                            {t.name}
                          </TableCell>
                          <TableCell className="text-right tabular-nums">{t.assigned}</TableCell>
                          <TableCell className="text-right tabular-nums">{t.completed}</TableCell>
                          <TableCell className="text-right tabular-nums">{t.active}</TableCell>
                          <TableCell className="text-right tabular-nums">
                            {t.avg_turnaround_hours !== null ? `${t.avg_turnaround_hours}h` : '—'}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </CardContent>
          </Card>
        </>
      )}
    </div>
  )
}
