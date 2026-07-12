import { useQuery } from '@tanstack/react-query'
import type { PaginatedResponse } from '@triserve/shared'
import {
  ArrowRight,
  Banknote,
  Boxes,
  CircleDollarSign,
  Package,
  ReceiptText,
  Users,
  Wrench,
} from 'lucide-react'
import { useMemo, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { api, apiErrorMessage } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { formatMoney } from '@/lib/format'
import type {
  DashboardSummaryWire,
  InvoiceWire,
  MoneyByCurrency,
  NamedTotal,
} from '@/lib/types'

const MONTH_LABELS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
]
function monthLabel(ym: string): string {
  const [, m] = ym.split('-')
  return MONTH_LABELS[Number(m) - 1] ?? ym
}

const METHOD_LABELS: Record<string, string> = {
  CASH: 'Cash',
  MPESA: 'M-Pesa',
  TIGOPESA: 'Tigo Pesa',
  AIRTEL: 'Airtel Money',
  CARD: 'Card',
  BANK: 'Bank / System',
}

/** One headline KPI tile. */
function StatCard({
  label,
  value,
  sub,
  icon,
  to,
  tone = 'default',
}: {
  label: string
  value: ReactNode
  sub?: ReactNode
  icon: ReactNode
  to?: string
  tone?: 'default' | 'positive' | 'warning'
}) {
  const chipCls =
    tone === 'positive'
      ? 'bg-emerald-500/12 text-emerald-600 dark:text-emerald-400'
      : tone === 'warning'
        ? 'bg-amber-500/15 text-amber-600 dark:text-amber-400'
        : 'bg-primary/10 text-primary'
  const body = (
    <Card className="h-full gap-2 transition-all hover:-translate-y-0.5 hover:border-ring/50 hover:shadow-md">
      <CardContent className="flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <span className="text-sm text-muted-foreground">{label}</span>
          <span className={`flex size-8 items-center justify-center rounded-lg ${chipCls}`}>
            {icon}
          </span>
        </div>
        <div className="text-2xl font-semibold tabular-nums">{value}</div>
        {sub && <div className="text-xs text-muted-foreground">{sub}</div>}
      </CardContent>
    </Card>
  )
  return to ? <Link to={to} className="block">{body}</Link> : body
}

function SectionCard({
  title,
  action,
  children,
  className,
}: {
  title: string
  action?: ReactNode
  children: ReactNode
  className?: string
}) {
  return (
    <Card className={'h-full ' + (className ?? '')}>
      <CardHeader className="flex-row items-center justify-between space-y-0">
        <CardTitle className="text-sm">{title}</CardTitle>
        {action}
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  )
}

/** Render a per-currency money list ("USD 1,234 · TSh 5,678"). */
function moneyList(rows: MoneyByCurrency[]): string {
  if (rows.length === 0) return formatMoney('0')
  return rows.map((r) => formatMoney(r.amount, r.currency)).join('  ·  ')
}

/** A labelled proportional bar. */
function BarRow({
  label,
  pct,
  trailing,
  accent = 'bg-primary',
}: {
  label: ReactNode
  pct: number
  trailing?: ReactNode
  accent?: string
}) {
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between gap-2 text-sm">
        <span className="truncate">{label}</span>
        <span className="shrink-0 tabular-nums text-muted-foreground">{trailing}</span>
      </div>
      <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
        <div
          className={`h-full rounded-full ${accent}`}
          style={{ width: `${Math.max(2, Math.min(100, pct))}%` }}
        />
      </div>
    </div>
  )
}

/**
 * Operations dashboard (§8). A server-side roll-up (GET /dashboard/summary)
 * powers the KPIs, the monthly takings trend and the branch/method/pipeline
 * breakdowns — accurate over the full history, not a 100-row page sample. A
 * live invoice feed rounds it out. USD (parts billed through Samsung's system)
 * and TZS (cash) are always kept as separate currencies, never summed.
 */
export function DashboardPage() {
  const { user, can } = useAuth()

  const summaryQuery = useQuery({
    queryKey: ['dashboard-summary'],
    queryFn: async () =>
      (await api.get<DashboardSummaryWire>('/dashboard/summary')).data,
    refetchInterval: 120_000,
  })

  const invoicesQuery = useQuery({
    queryKey: ['dashboard-recent-invoices'],
    enabled: can('invoice.read'),
    queryFn: async () =>
      (
        await api.get<PaginatedResponse<InvoiceWire>>('/invoices', {
          params: { page_size: 8 },
        })
      ).data.data,
  })

  const d = summaryQuery.data
  const firstName = user?.full_name?.split(' ')[0] ?? 'there'

  // Monthly trend: TZS series (the cash line) as vertical bars.
  const trend = useMemo(() => {
    if (!d) return []
    const byMonth = new Map<string, { tzs: bigint; usd: bigint }>()
    for (const p of d.monthly) {
      const e = byMonth.get(p.month) ?? { tzs: 0n, usd: 0n }
      if (p.currency === 'USD') e.usd += BigInt(p.amount)
      else e.tzs += BigInt(p.amount)
      byMonth.set(p.month, e)
    }
    return [...byMonth.entries()].map(([month, v]) => ({ month, ...v }))
  }, [d])
  const maxTrend = trend.reduce((m, t) => (t.tzs > m ? t.tzs : m), 1n)

  const activeStages = d?.jobs_by_state.filter((s) => !s.is_terminal) ?? []
  const maxStage = Math.max(1, ...activeStages.map((s) => s.count))

  // Branch revenue: fold the two currencies per branch into one row each.
  const branchRows = useMemo(() => {
    if (!d) return []
    const by = new Map<string, { label: string; tzs: bigint; usd: bigint; count: number }>()
    for (const r of d.by_branch) {
      const e = by.get(r.key) ?? { label: r.label, tzs: 0n, usd: 0n, count: 0 }
      if (r.currency === 'USD') e.usd += BigInt(r.amount)
      else e.tzs += BigInt(r.amount)
      e.count += r.count
      by.set(r.key, e)
    }
    return [...by.values()].sort((a, b) => (b.tzs > a.tzs ? 1 : -1))
  }, [d])
  const maxBranchTzs = branchRows.reduce((m, b) => (b.tzs > m ? b.tzs : m), 1n)

  const methodMax = (d?.by_method ?? []).reduce(
    (m, r) => (BigInt(r.amount) > m ? BigInt(r.amount) : m),
    1n,
  )

  return (
    <div className="space-y-6">
      <div className="relative overflow-hidden rounded-2xl border bg-gradient-to-br from-primary/10 via-primary/5 to-transparent p-5">
        <div className="pointer-events-none absolute -right-8 -top-10 size-40 rounded-full bg-primary/10 blur-2xl" />
        <h1 className="text-xl font-semibold">Welcome back, {firstName}</h1>
        <p className="text-sm text-muted-foreground">
          Operations across all branches, updated live.
        </p>
      </div>

      {summaryQuery.isError && (
        <p className="text-sm text-destructive">{apiErrorMessage(summaryQuery.error)}</p>
      )}

      {/* KPI row */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard
          label="Revenue · this month"
          value={
            <span className="text-lg">
              {d ? moneyList(d.revenue_this_month) : '…'}
            </span>
          }
          sub="Cash + system, by currency"
          icon={<Banknote className="size-4" />}
          tone="positive"
          to={can('invoice.read') ? '/invoices' : undefined}
        />
        <StatCard
          label="Revenue · all time"
          value={<span className="text-lg">{d ? moneyList(d.revenue_all_time) : '…'}</span>}
          sub={d ? `${d.revenue_all_time.reduce((n, r) => n + r.count, 0)} payments` : undefined}
          icon={<CircleDollarSign className="size-4" />}
          to={can('invoice.read') ? '/invoices' : undefined}
        />
        <StatCard
          label="Active jobs"
          value={d?.jobs_active ?? '…'}
          sub={d ? `${d.counts.customers.toLocaleString()} customers on file` : undefined}
          icon={<Wrench className="size-4" />}
          to={can('job.read') ? '/jobs' : undefined}
        />
        <StatCard
          label="Stock on hand"
          value={d ? d.counts.stock_on_hand.toLocaleString() : '…'}
          sub={
            d
              ? `${d.counts.parts} parts${d.counts.low_stock > 0 ? ` · ${d.counts.low_stock} low` : ''}`
              : undefined
          }
          icon={<Boxes className="size-4" />}
          tone={d && d.counts.low_stock > 0 ? 'warning' : 'default'}
          to={can('inventory.read') ? '/inventory' : undefined}
        />
      </div>

      {/* Monthly trend + method split */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <SectionCard title="Monthly takings · cash (TSh)" className="lg:col-span-2">
          {!d ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : trend.length === 0 ? (
            <p className="text-sm text-muted-foreground">No payments recorded yet.</p>
          ) : (
            <div className="flex h-44 items-end gap-2">
              {trend.map((t) => {
                const h = maxTrend > 0n ? Number((t.tzs * 100n) / maxTrend) : 0
                return (
                  <div
                    key={t.month}
                    className="flex h-full flex-1 flex-col items-center justify-end gap-1"
                  >
                    <div className="flex w-full flex-1 items-end">
                      <div
                        className="w-full rounded-t bg-primary/80 transition-all hover:bg-primary"
                        style={{ height: `${t.tzs > 0n ? Math.max(2, h) : 0}%` }}
                        title={`${monthLabel(t.month)}: ${formatMoney(t.tzs.toString())}`}
                      />
                    </div>
                    <span className="text-[10px] text-muted-foreground">{monthLabel(t.month)}</span>
                  </div>
                )
              })}
            </div>
          )}
        </SectionCard>

        <SectionCard title="By payment method">
          {!d ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : d.by_method.length === 0 ? (
            <p className="text-sm text-muted-foreground">No payments yet.</p>
          ) : (
            <div className="space-y-3">
              {d.by_method.map((m: NamedTotal) => (
                <BarRow
                  key={`${m.key}-${m.currency}`}
                  label={METHOD_LABELS[m.key] ?? m.key}
                  pct={Number((BigInt(m.amount) * 100n) / methodMax)}
                  trailing={formatMoney(m.amount, m.currency)}
                  accent="bg-emerald-500"
                />
              ))}
            </div>
          )}
        </SectionCard>
      </div>

      {/* Branch revenue + job pipeline */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <SectionCard title="Revenue by branch" className="lg:col-span-2">
          {!d ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : branchRows.length === 0 ? (
            <p className="text-sm text-muted-foreground">No branch revenue yet.</p>
          ) : (
            <div className="space-y-3">
              {branchRows.map((b) => (
                <BarRow
                  key={b.label}
                  label={
                    <span className="flex items-center gap-2">
                      {b.label}
                      {b.usd > 0n && (
                        <Badge variant="outline" className="text-[10px]">
                          {formatMoney(b.usd.toString(), 'USD')}
                        </Badge>
                      )}
                    </span>
                  }
                  pct={Number((b.tzs * 100n) / maxBranchTzs)}
                  trailing={formatMoney(b.tzs.toString())}
                />
              ))}
            </div>
          )}
        </SectionCard>

        <SectionCard
          title="Job pipeline"
          action={
            can('job.read') ? (
              <Link to="/jobs" className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
                Board <ArrowRight className="size-3" />
              </Link>
            ) : undefined
          }
        >
          {!d ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : activeStages.every((s) => s.count === 0) ? (
            <p className="text-sm text-muted-foreground">No open jobs.</p>
          ) : (
            <div className="space-y-3">
              {activeStages
                .filter((s) => s.count > 0)
                .map((s) => (
                  <BarRow
                    key={s.code}
                    label={s.label}
                    pct={(s.count / maxStage) * 100}
                    trailing={s.count.toLocaleString()}
                    accent="bg-sky-500"
                  />
                ))}
            </div>
          )}
        </SectionCard>
      </div>

      {/* Recent invoices + at-a-glance counts */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        {can('invoice.read') && (
          <SectionCard
            title="Recent invoices"
            className="lg:col-span-2"
            action={
              <Link to="/invoices" className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
                All invoices <ArrowRight className="size-3" />
              </Link>
            }
          >
            {invoicesQuery.isPending ? (
              <p className="text-sm text-muted-foreground">Loading…</p>
            ) : (invoicesQuery.data?.length ?? 0) === 0 ? (
              <p className="text-sm text-muted-foreground">No invoices yet.</p>
            ) : (
              <div className="divide-y">
                {invoicesQuery.data!.map((inv) => (
                  <div key={inv.id} className="flex items-center justify-between gap-3 py-2 text-sm">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <ReceiptText className="size-3.5 shrink-0 text-muted-foreground" />
                        <span className="font-medium">{inv.invoice_no}</span>
                        <InvoiceStatusBadge status={inv.status} />
                      </div>
                      <div className="truncate text-xs text-muted-foreground">
                        {inv.customer_name ?? 'Walk-in'} · {inv.branch_code}
                      </div>
                    </div>
                    <div className="text-right">
                      <div className="font-medium tabular-nums">
                        {formatMoney(inv.total, inv.currency)}
                      </div>
                      {BigInt(inv.balance) > 0n && (
                        <div className="text-xs text-amber-600 tabular-nums dark:text-amber-400">
                          {formatMoney(inv.balance, inv.currency)} due
                        </div>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </SectionCard>
        )}

        <SectionCard title="At a glance">
          {!d ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : (
            <dl className="space-y-2.5 text-sm">
              <CountRow icon={<Users className="size-4" />} label="Customers" value={d.counts.customers} to={can('customer.read') ? '/jobs' : undefined} />
              <CountRow icon={<Wrench className="size-4" />} label="Devices booked" value={d.counts.devices} />
              <CountRow icon={<Package className="size-4" />} label="Parts catalogue" value={d.counts.parts} to={can('part.read') ? '/inventory/parts' : undefined} />
              <CountRow icon={<Boxes className="size-4" />} label="Units in stock" value={d.counts.stock_on_hand} to={can('inventory.read') ? '/inventory' : undefined} />
              <CountRow icon={<ReceiptText className="size-4" />} label="Open invoices" value={d.counts.open_invoices} to={can('invoice.read') ? '/invoices' : undefined} />
            </dl>
          )}
        </SectionCard>
      </div>

      {d && (
        <p className="text-xs text-muted-foreground">
          Figures aggregated across all history. Last refreshed just now.
        </p>
      )}
    </div>
  )
}

function CountRow({
  icon,
  label,
  value,
  to,
}: {
  icon: ReactNode
  label: string
  value: number
  to?: string
}) {
  const inner = (
    <div className="flex items-center justify-between">
      <dt className="flex items-center gap-2 text-muted-foreground">
        {icon}
        {label}
      </dt>
      <dd className="font-medium tabular-nums">{value.toLocaleString()}</dd>
    </div>
  )
  return to ? (
    <Link to={to} className="block rounded px-1 hover:bg-muted">
      {inner}
    </Link>
  ) : (
    inner
  )
}

function InvoiceStatusBadge({ status }: { status: InvoiceWire['status'] }) {
  switch (status) {
    case 'PAID':
      return <Badge variant="success">Paid</Badge>
    case 'PARTIAL':
      return <Badge variant="warning">Part-paid</Badge>
    case 'DRAFT':
      return <Badge variant="secondary">Draft</Badge>
    case 'REFUNDED':
      return <Badge variant="warning">Refunded</Badge>
    default:
      return <Badge variant="destructive">Void</Badge>
  }
}
