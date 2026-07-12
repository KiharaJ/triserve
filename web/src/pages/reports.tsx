import { useQuery } from '@tanstack/react-query'
import { BarChart3, Scale } from 'lucide-react'
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
import { formatMoney } from '@/lib/format'
import { cn } from '@/lib/utils'
import type { ProfitLossWire, TrialBalanceWire } from '@/lib/types'

type Report = 'trial-balance' | 'profit-loss'

const TYPE_LABEL: Record<string, string> = {
  ASSET: 'Assets',
  LIABILITY: 'Liabilities',
  EQUITY: 'Equity',
  REVENUE: 'Revenue',
  EXPENSE: 'Expenses',
}
const TYPE_ORDER = ['ASSET', 'LIABILITY', 'EQUITY', 'REVENUE', 'EXPENSE']

/**
 * Financial reports (Phase 5 / E1) — Trial Balance and Profit & Loss straight
 * off the live double-entry ledger, grouped by currency (TZS cash + USD Samsung
 * warranty are never summed without an fx rate). Read-only; accounting.read.
 */
export function ReportsPage() {
  const [report, setReport] = useState<Report>('profit-loss')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')

  const params = {
    ...(from ? { from } : {}),
    ...(to ? { to } : {}),
  }

  const tb = useQuery({
    queryKey: ['report', 'trial-balance', from, to],
    enabled: report === 'trial-balance',
    queryFn: async () =>
      (await api.get<TrialBalanceWire>('/reports/trial-balance', { params })).data,
  })
  const pl = useQuery({
    queryKey: ['report', 'profit-loss', from, to],
    enabled: report === 'profit-loss',
    queryFn: async () =>
      (await api.get<ProfitLossWire>('/reports/profit-loss', { params })).data,
  })

  const active = report === 'trial-balance' ? tb : pl

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="inline-flex rounded-lg border bg-muted/40 p-0.5">
          <TabButton
            active={report === 'profit-loss'}
            onClick={() => setReport('profit-loss')}
            icon={<BarChart3 className="size-4" />}
            label="Profit &amp; Loss"
          />
          <TabButton
            active={report === 'trial-balance'}
            onClick={() => setReport('trial-balance')}
            icon={<Scale className="size-4" />}
            label="Trial Balance"
          />
        </div>
        <div className="flex-1" />
        <label className="flex items-center gap-1.5 text-sm text-muted-foreground">
          From
          <Input
            type="date"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
            className="w-40"
          />
        </label>
        <label className="flex items-center gap-1.5 text-sm text-muted-foreground">
          To
          <Input
            type="date"
            value={to}
            onChange={(e) => setTo(e.target.value)}
            className="w-40"
          />
        </label>
      </div>

      {active.isPending && <p className="text-sm text-muted-foreground">Loading…</p>}
      {active.isError && (
        <p className="text-sm text-destructive">{apiErrorMessage(active.error)}</p>
      )}

      {report === 'profit-loss' && pl.data && <ProfitLoss data={pl.data} />}
      {report === 'trial-balance' && tb.data && <TrialBalance data={tb.data} />}
    </div>
  )
}

function ProfitLoss({ data }: { data: ProfitLossWire }) {
  if (data.currencies.length === 0)
    return <EmptyState label="No posted revenue or expenses in this period." />
  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
      {data.currencies.map((c) => {
        const profit = BigInt(c.net_profit) >= 0n
        return (
          <Card key={c.currency}>
            <CardHeader className="flex-row items-center justify-between space-y-0">
              <CardTitle className="text-base">Profit &amp; Loss · {c.currency}</CardTitle>
              <Badge variant={profit ? 'success' : 'destructive'}>
                {profit ? 'Profit' : 'Loss'}
              </Badge>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              <PlBlock title="Revenue" lines={c.revenue} currency={c.currency} />
              <PlBlock title="Expenses" lines={c.expenses} currency={c.currency} />
              <div className="flex items-center justify-between border-t pt-3 text-base font-semibold">
                <span>Net {profit ? 'profit' : 'loss'}</span>
                <span
                  className={cn(
                    'tabular-nums',
                    profit ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400',
                  )}
                >
                  {formatMoney(c.net_profit, c.currency)}
                </span>
              </div>
            </CardContent>
          </Card>
        )
      })}
    </div>
  )
}

function PlBlock({
  title,
  lines,
  currency,
}: {
  title: string
  lines: { code: string; name: string; amount: string }[]
  currency: string
}) {
  const total = lines.reduce((s, l) => s + BigInt(l.amount), 0n)
  return (
    <div>
      <div className="mb-1 flex items-center justify-between text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        <span>{title}</span>
        <span className="tabular-nums">{formatMoney(total.toString(), currency)}</span>
      </div>
      {lines.length === 0 ? (
        <p className="text-sm text-muted-foreground">None.</p>
      ) : (
        <div className="flex flex-col gap-1 text-sm">
          {lines.map((l) => (
            <div key={l.code} className="flex items-center justify-between">
              <span>
                <span className="text-muted-foreground">{l.code}</span> {l.name}
              </span>
              <span className="tabular-nums">{formatMoney(l.amount, currency)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function TrialBalance({ data }: { data: TrialBalanceWire }) {
  if (data.currencies.length === 0)
    return <EmptyState label="No ledger entries in this period." />
  return (
    <div className="flex flex-col gap-4">
      {data.currencies.map((c) => (
        <Card key={c.currency}>
          <CardHeader className="flex-row items-center justify-between space-y-0">
            <CardTitle className="text-base">Trial Balance · {c.currency}</CardTitle>
            <Badge variant={c.balanced ? 'success' : 'destructive'}>
              {c.balanced ? 'Balanced' : 'Out of balance'}
            </Badge>
          </CardHeader>
          <CardContent>
            <div className="overflow-hidden rounded-lg border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Code</TableHead>
                    <TableHead>Account</TableHead>
                    <TableHead className="text-right">Debit</TableHead>
                    <TableHead className="text-right">Credit</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {[...c.rows]
                    .sort(
                      (a, b) =>
                        TYPE_ORDER.indexOf(a.type) - TYPE_ORDER.indexOf(b.type) ||
                        a.code.localeCompare(b.code),
                    )
                    .map((r) => {
                      const bal = BigInt(r.balance)
                      return (
                        <TableRow key={r.code}>
                          <TableCell className="font-mono text-sm">{r.code}</TableCell>
                          <TableCell>
                            {r.name}
                            <span className="ml-2 text-xs text-muted-foreground">
                              {TYPE_LABEL[r.type] ?? r.type}
                            </span>
                          </TableCell>
                          <TableCell className="text-right tabular-nums">
                            {bal > 0n ? formatMoney(bal.toString(), c.currency) : '—'}
                          </TableCell>
                          <TableCell className="text-right tabular-nums">
                            {bal < 0n ? formatMoney((-bal).toString(), c.currency) : '—'}
                          </TableCell>
                        </TableRow>
                      )
                    })}
                  <TableRow className="font-semibold">
                    <TableCell colSpan={2}>Total</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatMoney(c.total_debit, c.currency)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatMoney(c.total_credit, c.currency)}
                    </TableCell>
                  </TableRow>
                </TableBody>
              </Table>
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  )
}

function EmptyState({ label }: { label: string }) {
  return (
    <Card>
      <CardContent className="py-10 text-center text-sm text-muted-foreground">
        {label}
      </CardContent>
    </Card>
  )
}

function TabButton({
  active,
  onClick,
  icon,
  label,
}: {
  active: boolean
  onClick: () => void
  icon: React.ReactNode
  label: string
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors',
        active
          ? 'bg-card text-foreground shadow-sm'
          : 'text-muted-foreground hover:text-foreground',
      )}
    >
      {icon}
      {label}
    </button>
  )
}
