import { useQuery } from '@tanstack/react-query'
import { AlertTriangle, CalendarClock, Flame, UserX, Clock, Layers } from 'lucide-react'
import { Link } from 'react-router-dom'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { api, apiErrorMessage } from '@/lib/api'
import { formatDateTime } from '@/lib/format'
import type { FloorSnapshotWire } from '@/lib/types'

/**
 * "Right now" — what a manager or owner wants on walking in.
 *
 * Distinct from Operations, which is historical BI over a date range. This is
 * a point-in-time snapshot: what needs attention, where work is piling up, and
 * who is carrying it. Everything counts OPEN jobs only — a job that finished
 * late is history, not something to chase.
 *
 * Every tile links to the filtered job list, so a number is a starting point
 * rather than a dead end.
 */
export function WorkloadPage() {
  const snap = useQuery({
    queryKey: ['reports', 'snapshot'],
    queryFn: async () => (await api.get<FloorSnapshotWire>('/reports/snapshot')).data,
    // The whole point is freshness; a stale snapshot is worse than none.
    refetchInterval: 60_000,
  })

  if (snap.isPending) {
    return <p className="text-sm text-muted-foreground">Loading…</p>
  }
  if (snap.isError) {
    return <p className="text-sm text-destructive">{apiErrorMessage(snap.error)}</p>
  }

  const d = snap.data
  const maxState = Math.max(1, ...d.by_state.map((s) => s.count))

  return (
    <div className="flex flex-col gap-4">
      <p className="text-xs text-muted-foreground">
        As of {formatDateTime(d.at)} · open jobs only · refreshes every minute
      </p>

      {/* The six numbers worth acting on, each a link into the work itself. */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-3 xl:grid-cols-6">
        <Tile
          label="Open jobs"
          value={d.attention.open}
          icon={<Layers className="size-4" />}
          to="/jobs"
        />
        <Tile
          label="Overdue"
          value={d.attention.overdue}
          icon={<AlertTriangle className="size-4" />}
          to="/jobs?overdue=true"
          tone={d.attention.overdue > 0 ? 'bad' : undefined}
        />
        <Tile
          label="Due today"
          value={d.attention.due_today}
          icon={<CalendarClock className="size-4" />}
          to="/jobs"
          tone={d.attention.due_today > 0 ? 'warn' : undefined}
        />
        <Tile
          label="Urgent / high"
          value={d.attention.urgent}
          icon={<Flame className="size-4" />}
          to="/jobs?priority=URGENT"
          tone={d.attention.urgent > 0 ? 'warn' : undefined}
        />
        <Tile
          label="Unassigned"
          value={d.attention.unassigned}
          icon={<UserX className="size-4" />}
          to="/jobs"
          tone={d.attention.unassigned > 0 ? 'warn' : undefined}
        />
        <Tile
          label="Older than 14 days"
          value={d.attention.stale}
          icon={<Clock className="size-4" />}
          to="/jobs"
          tone={d.attention.stale > 0 ? 'bad' : undefined}
        />
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Panel title="Where the work is sitting">
          {d.by_state.length === 0 ? (
            <Empty />
          ) : (
            <div className="flex flex-col gap-2.5">
              {d.by_state.map((s) => (
                <div key={s.code} className="flex flex-col gap-1">
                  <div className="flex items-center justify-between text-sm">
                    <span className="truncate">{s.label}</span>
                    <span className="tabular-nums text-muted-foreground">
                      {s.count}
                      {s.overdue > 0 && (
                        <span className="ml-1.5 text-destructive">
                          {s.overdue} late
                        </span>
                      )}
                    </span>
                  </div>
                  {/* Two-tone bar: the red portion is the late share of that
                      column, so a bottleneck and a backlog look different. */}
                  <div className="flex h-2 w-full overflow-hidden rounded-full bg-muted">
                    <div
                      className="h-full bg-destructive"
                      style={{ width: `${(s.overdue / maxState) * 100}%` }}
                    />
                    <div
                      className="h-full bg-primary"
                      style={{
                        width: `${((s.count - s.overdue) / maxState) * 100}%`,
                      }}
                    />
                  </div>
                </div>
              ))}
            </div>
          )}
        </Panel>

        <Panel title="How long jobs have been here">
          {d.aging.every((b) => b.count === 0) ? (
            <Empty />
          ) : (
            <Bars rows={d.aging.map((b) => ({ label: b.bucket, value: b.count }))} />
          )}
        </Panel>

        <Panel title="Who is carrying it">
          {d.engineers.length === 0 ? (
            <Empty />
          ) : (
            <div className="flex flex-col gap-2">
              {d.engineers.map((e) => (
                <div
                  key={e.engineer_id ?? 'unassigned'}
                  className="flex items-center justify-between gap-2 text-sm"
                >
                  <span
                    className={
                      'truncate ' +
                      (e.engineer_id === null ? 'font-medium text-amber-700 dark:text-amber-400' : '')
                    }
                  >
                    {e.name}
                  </span>
                  <span className="flex shrink-0 items-center gap-2 tabular-nums text-muted-foreground">
                    {e.oldest_days !== null && (
                      <span title="Age of their oldest open job">
                        oldest {e.oldest_days}d
                      </span>
                    )}
                    {e.overdue > 0 && (
                      <span className="text-destructive">{e.overdue} late</span>
                    )}
                    <span className="font-medium text-foreground">{e.active}</span>
                  </span>
                </div>
              ))}
            </div>
          )}
        </Panel>

        <Panel title="By service line">
          {d.by_line.length === 0 ? (
            <Empty />
          ) : (
            <div className="flex flex-col gap-2">
              {d.by_line.map((l) => (
                <div
                  key={l.service_category_id ?? 'none'}
                  className="flex items-center justify-between gap-2 text-sm"
                >
                  <span className="truncate">{l.label}</span>
                  <span className="flex shrink-0 items-center gap-2 tabular-nums text-muted-foreground">
                    {l.overdue > 0 && (
                      <span className="text-destructive">{l.overdue} late</span>
                    )}
                    <span className="font-medium text-foreground">{l.count}</span>
                  </span>
                </div>
              ))}
            </div>
          )}
        </Panel>
      </div>
    </div>
  )
}

function Tile({
  label,
  value,
  icon,
  to,
  tone,
}: {
  label: string
  value: number
  icon: React.ReactNode
  to: string
  tone?: 'warn' | 'bad'
}) {
  const toneClass =
    tone === 'bad'
      ? 'border-destructive/30 bg-destructive/5'
      : tone === 'warn'
        ? 'border-amber-500/30 bg-amber-500/5'
        : ''
  return (
    <Link to={to}>
      <Card className={'transition-colors hover:bg-accent/40 ' + toneClass}>
        <CardContent className="flex flex-col gap-1 py-3">
          <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
            {icon}
            {label}
          </span>
          <span className="text-2xl font-semibold tabular-nums">{value}</span>
        </CardContent>
      </Card>
    </Link>
  )
}

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm">{title}</CardTitle>
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  )
}

function Bars({ rows }: { rows: { label: string; value: number }[] }) {
  const max = Math.max(1, ...rows.map((r) => r.value))
  return (
    <div className="space-y-2.5">
      {rows.map((r) => (
        <div key={r.label} className="flex flex-col gap-1">
          <div className="flex items-center justify-between text-sm">
            <span className="truncate">{r.label}</span>
            <span className="tabular-nums text-muted-foreground">
              {r.value.toLocaleString()}
            </span>
          </div>
          <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
            {/* A minimum width keeps a small non-zero bar visible, but zero
                must render NOTHING — a bar for "0" reads as "a few". */}
            {r.value > 0 && (
              <div
                className="h-full rounded-full bg-primary"
                style={{
                  width: `${Math.max(2, Math.round((r.value / max) * 100))}%`,
                }}
              />
            )}
          </div>
        </div>
      ))}
    </div>
  )
}

function Empty() {
  return <p className="text-sm text-muted-foreground">Nothing open right now.</p>
}
