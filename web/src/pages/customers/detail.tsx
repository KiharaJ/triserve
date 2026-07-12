import { useQuery } from '@tanstack/react-query'
import {
  Banknote,
  CircleAlert,
  ReceiptText,
  ShieldCheck,
  Smartphone,
  Wrench,
} from 'lucide-react'
import type { ReactNode } from 'react'
import { Link, useParams } from 'react-router-dom'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { api, apiErrorMessage } from '@/lib/api'
import { formatDate, formatMoney } from '@/lib/format'
import type {
  CustomerProfileWire,
  InvoiceStatus,
  ProfileMoney,
  WarrantyClaimStatus,
  WarrantyStatus,
} from '@/lib/types'

function initials(name: string): string {
  return name
    .split(/\s+/)
    .slice(0, 2)
    .map((n) => n[0])
    .join('')
    .toUpperCase()
}

function moneyList(rows: ProfileMoney[]): string {
  if (rows.length === 0) return formatMoney('0')
  return rows.map((r) => formatMoney(r.amount, r.currency)).join(' · ')
}

function warrantyBadge(status: WarrantyStatus) {
  switch (status) {
    case 'IW':
      return <Badge variant="success">IW</Badge>
    case 'OW':
      return <Badge variant="warning">OW</Badge>
    case 'GOODWILL':
      return <Badge variant="secondary">Goodwill</Badge>
    default:
      return <Badge variant="outline">Unknown</Badge>
  }
}

function invoiceStatusBadge(status: InvoiceStatus) {
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

function claimStatusBadge(status: WarrantyClaimStatus) {
  switch (status) {
    case 'APPROVED':
    case 'PAID':
      return <Badge variant="success">{status === 'PAID' ? 'Paid' : 'Approved'}</Badge>
    case 'SUBMITTED':
      return <Badge variant="warning">Submitted</Badge>
    case 'REJECTED':
    case 'CANCELLED':
      return <Badge variant="destructive">{status === 'REJECTED' ? 'Rejected' : 'Cancelled'}</Badge>
    default:
      return <Badge variant="secondary">Draft</Badge>
  }
}

function StatTile({
  label,
  value,
  icon,
  tone,
  sub,
}: {
  label: string
  value: ReactNode
  icon: ReactNode
  tone: string
  sub?: ReactNode
}) {
  return (
    <Card className="gap-2">
      <CardContent className="flex flex-col gap-1.5">
        <div className="flex items-center justify-between">
          <span className="text-xs text-muted-foreground">{label}</span>
          <span className={`flex size-7 items-center justify-center rounded-lg ${tone}`}>
            {icon}
          </span>
        </div>
        <div className="text-lg font-semibold tabular-nums">{value}</div>
        {sub && <div className="text-xs text-muted-foreground">{sub}</div>}
      </CardContent>
    </Card>
  )
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{title}</CardTitle>
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  )
}

function Field({
  label,
  value,
  className,
}: {
  label: string
  value: ReactNode
  className?: string
}) {
  return (
    <div className={className}>
      <span className="text-muted-foreground">{label}: </span>
      {value ?? '—'}
    </div>
  )
}

/**
 * Customer 360 (Phase 5, §4.2 / E2). One GET /customers/{id}/profile assembles
 * the whole view — devices, repair history, invoices, warranty claims — with
 * lifetime spend and outstanding balance COMPUTED server-side (never stored).
 */
export function CustomerDetailPage() {
  const { id } = useParams<{ id: string }>()

  const profile = useQuery({
    queryKey: ['customer-profile', id],
    enabled: Boolean(id),
    queryFn: async () =>
      (await api.get<CustomerProfileWire>(`/customers/${id}/profile`)).data,
  })

  if (profile.isPending)
    return <p className="text-sm text-muted-foreground">Loading…</p>
  if (profile.isError)
    return <p className="text-sm text-destructive">{apiErrorMessage(profile.error)}</p>
  const p = profile.data
  if (!p) return null
  const c = p.customer
  const s = p.stats
  const hasOutstanding = s.outstanding.length > 0

  return (
    <div className="flex flex-col gap-4">
      {/* Header */}
      <Card className="overflow-hidden">
        <div className="bg-gradient-to-br from-primary/10 via-primary/5 to-transparent px-5 py-4">
          <div className="flex items-center gap-4">
            <span className="flex size-14 shrink-0 items-center justify-center rounded-2xl bg-gradient-to-br from-indigo-500 to-blue-600 text-lg font-bold text-white shadow-md">
              {initials(c.name)}
            </span>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h1 className="text-xl font-semibold">{c.name}</h1>
                {c.is_dealer && <Badge variant="info">Dealer</Badge>}
                {c.rating !== null && (
                  <Badge variant="outline">★ {c.rating}/5</Badge>
                )}
              </div>
              <p className="text-sm text-muted-foreground">
                {[c.phone, c.location].filter(Boolean).join(' · ') || 'No contact on file'}
              </p>
            </div>
          </div>
        </div>
        <CardContent className="grid grid-cols-2 gap-x-6 gap-y-1.5 text-sm sm:grid-cols-4">
          <Field label="Phone" value={c.phone} />
          <Field label="Alt phone" value={c.alt_phone} />
          <Field label="Email" value={c.email} />
          <Field label="Language" value={c.preferred_language} />
          <Field label="First seen" value={s.first_seen ? formatDate(s.first_seen) : '—'} />
          <Field label="Last visit" value={s.last_visit ? formatDate(s.last_visit) : '—'} />
          {c.dealer_name && <Field label="Dealer" value={c.dealer_name} />}
          {c.notes && <Field label="Notes" value={c.notes} className="col-span-full" />}
        </CardContent>
      </Card>

      {/* Stat tiles */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-6">
        <StatTile
          label="Jobs"
          value={s.total_jobs}
          sub={`${s.active_jobs} active`}
          icon={<Wrench className="size-4" />}
          tone="bg-blue-500/15 text-blue-600 dark:text-blue-400"
        />
        <StatTile
          label="Devices"
          value={s.total_devices}
          icon={<Smartphone className="size-4" />}
          tone="bg-teal-500/15 text-teal-600 dark:text-teal-400"
        />
        <StatTile
          label="Invoices"
          value={s.total_invoices}
          icon={<ReceiptText className="size-4" />}
          tone="bg-violet-500/15 text-violet-600 dark:text-violet-400"
        />
        <StatTile
          label="Lifetime spend"
          value={<span className="text-sm">{moneyList(s.lifetime_spend)}</span>}
          icon={<Banknote className="size-4" />}
          tone="bg-emerald-500/15 text-emerald-600 dark:text-emerald-400"
        />
        <StatTile
          label="Outstanding"
          value={
            <span className={'text-sm ' + (hasOutstanding ? 'text-amber-600 dark:text-amber-400' : '')}>
              {moneyList(s.outstanding)}
            </span>
          }
          icon={<CircleAlert className="size-4" />}
          tone="bg-amber-500/15 text-amber-600 dark:text-amber-400"
        />
        <StatTile
          label="Warranty"
          value={s.warranty_claims}
          sub={
            s.warranty_reimbursed_usd !== '0'
              ? `${formatMoney(s.warranty_reimbursed_usd, 'USD')} back`
              : undefined
          }
          icon={<ShieldCheck className="size-4" />}
          tone="bg-rose-500/15 text-rose-600 dark:text-rose-400"
        />
      </div>

      {/* Repair history */}
      <Section title="Repair history">
        {p.jobs.length === 0 ? (
          <p className="text-sm text-muted-foreground">No jobs on file.</p>
        ) : (
          <div className="overflow-hidden rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Job #</TableHead>
                  <TableHead>Device</TableHead>
                  <TableHead>State</TableHead>
                  <TableHead>Warranty</TableHead>
                  <TableHead className="text-right">Received</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {p.jobs.slice(0, 25).map((j) => (
                  <TableRow key={j.id}>
                    <TableCell>
                      <Link
                        to={`/jobs/${j.id}`}
                        className="font-mono text-sm font-medium hover:underline"
                      >
                        {j.job_no}
                      </Link>
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {j.device_model ?? '—'}
                    </TableCell>
                    <TableCell>
                      <Badge variant={j.is_terminal ? 'secondary' : 'info'}>
                        {j.state_label}
                      </Badge>
                    </TableCell>
                    <TableCell>{warrantyBadge(j.warranty_status)}</TableCell>
                    <TableCell className="text-right text-muted-foreground">
                      {formatDate(j.received_at)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </Section>

      {/* Devices */}
      <Section title="Devices">
        {p.devices.length === 0 ? (
          <p className="text-sm text-muted-foreground">No devices on file.</p>
        ) : (
          <div className="overflow-hidden rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Brand / Model</TableHead>
                  <TableHead>Category</TableHead>
                  <TableHead>IMEI / Serial</TableHead>
                  <TableHead>Colour</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {p.devices.slice(0, 25).map((d) => (
                  <TableRow key={d.id}>
                    <TableCell className="font-medium">
                      {d.brand} {d.model ?? ''}
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline">{d.category}</Badge>
                    </TableCell>
                    <TableCell className="font-mono text-xs">
                      {d.imei_serial ?? '—'}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {d.color ?? '—'}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </Section>

      {/* Invoices */}
      {p.invoices.length > 0 && (
        <Section title="Purchases & invoices">
          <div className="overflow-hidden rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Invoice</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead className="text-right">Total</TableHead>
                  <TableHead className="text-right">Balance</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Date</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {p.invoices.slice(0, 25).map((inv) => (
                  <TableRow key={inv.id}>
                    <TableCell className="font-mono text-sm font-medium">
                      {inv.invoice_no}
                    </TableCell>
                    <TableCell className="text-muted-foreground">{inv.type}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatMoney(inv.total, inv.currency)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {BigInt(inv.balance) > 0n ? (
                        <span className="text-amber-600 dark:text-amber-400">
                          {formatMoney(inv.balance, inv.currency)}
                        </span>
                      ) : (
                        '—'
                      )}
                    </TableCell>
                    <TableCell>{invoiceStatusBadge(inv.status)}</TableCell>
                    <TableCell className="text-right text-muted-foreground">
                      {formatDate(inv.created_at)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </Section>
      )}

      {/* Warranty claims */}
      {p.warranty.length > 0 && (
        <Section title="Warranty claims">
          <div className="overflow-hidden rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Claim #</TableHead>
                  <TableHead className="text-right">Claimed (USD)</TableHead>
                  <TableHead className="text-right">Reimbursed</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Date</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {p.warranty.slice(0, 25).map((w) => (
                  <TableRow key={w.id}>
                    <TableCell className="font-mono text-sm">
                      {w.claim_no ?? '—'}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatMoney(w.claim_amount_usd, 'USD')}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {w.reimbursed_amount_usd
                        ? formatMoney(w.reimbursed_amount_usd, 'USD')
                        : '—'}
                    </TableCell>
                    <TableCell>{claimStatusBadge(w.status)}</TableCell>
                    <TableCell className="text-right text-muted-foreground">
                      {formatDate(w.created_at)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </Section>
      )}
    </div>
  )
}
