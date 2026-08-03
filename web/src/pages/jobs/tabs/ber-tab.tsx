import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Calculator, ShieldAlert } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import type { PaginatedResponse } from '@triserve/shared'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { api, apiErrorMessage } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { formatDateTime, formatMoney } from '@/lib/format'
import { cn } from '@/lib/utils'
import type {
  BerAssessment,
  BerEvaluateResult,
  BerOutcome,
  JobDetailWire,
  SwapUnit,
} from '@/lib/types'

/**
 * Beyond Economic Repair and replacement (SCMS proposal Module 4, §5).
 *
 * "If (Total Cost of Estimated SKU Parts + Estimated Labor Cost) >= 70% of the
 * Device's current Fair Commercial Market Value, the system halts the standard
 * track and fires a BER Warning flag."
 *
 * The panel walks the four steps: evaluate → supervisor certifies → record the
 * customer's choice → issue a replacement from the Swap Buffer Stock.
 */
export function BerTab({ job }: { job: JobDetailWire }) {
  const { can } = useAuth()
  const queryClient = useQueryClient()

  const assessments = useQuery({
    queryKey: ['ber', job.id],
    queryFn: async () =>
      (
        await api.get<PaginatedResponse<BerAssessment>>('/ber', {
          params: { job_id: job.id, page_size: 20 },
        })
      ).data.data,
  })

  function refresh() {
    void queryClient.invalidateQueries({ queryKey: ['ber', job.id] })
    void queryClient.invalidateQueries({ queryKey: ['job', job.id] })
    void queryClient.invalidateQueries({ queryKey: ['job-swaps', job.id] })
  }

  const live = assessments.data?.find(
    (a) => a.status === 'FLAGGED' || a.status === 'CERTIFIED',
  )

  return (
    <div className="flex flex-col gap-4">
      {can('job.ber.evaluate') && <EvaluateCard job={job} onDone={refresh} />}
      {live && <AssessmentCard job={job} ber={live} onDone={refresh} />}
      {live?.status === 'CERTIFIED' &&
        can('job.swap.execute') &&
        (live.outcome === 'REPLACE_IW' ||
          live.outcome === 'REPLACE_TRADE_UP') && (
          <SwapCard job={job} onDone={refresh} />
        )}
      <HistoryList
        assessments={(assessments.data ?? []).filter((a) => a.id !== live?.id)}
      />
    </div>
  )
}

// ---------------------------------------------------------------------------

function EvaluateCard({
  job,
  onDone,
}: {
  job: JobDetailWire
  onDone: () => void
}) {
  const [deviceValue, setDeviceValue] = useState('')
  const [result, setResult] = useState<BerEvaluateResult | null>(null)

  const run = useMutation({
    mutationFn: async (dryRun: boolean) =>
      (
        await api.post<BerEvaluateResult>(`/jobs/${job.id}/ber/evaluate`, {
          dry_run: dryRun,
          ...(deviceValue.trim()
            ? {
                device_value: String(
                  Math.round(Number(deviceValue.replace(/[^\d.]/g, '')) * 100),
                ),
              }
            : {}),
        })
      ).data,
    onSuccess: (data, dryRun) => {
      setResult(data)
      if (!dryRun && data.assessment) {
        toast.warning('Flagged Beyond Economic Repair — sent for review')
        onDone()
      } else if (!dryRun) {
        toast.success('Within the economic threshold — repair continues')
      }
    },
    onError: (e) => toast.error(apiErrorMessage(e)),
  })

  const preview = result?.preview

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Calculator className="size-4" /> Economic repair check
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <div className="flex flex-wrap items-end gap-2">
          <div>
            <p className="mb-1.5 text-sm font-medium">
              Device market value (TZS)
            </p>
            <Input
              className="w-44"
              inputMode="numeric"
              placeholder="From the catalogue"
              value={deviceValue}
              onChange={(e) => setDeviceValue(e.target.value)}
            />
          </div>
          <Button
            type="button"
            variant="outline"
            disabled={run.isPending}
            onClick={() => run.mutate(true)}
          >
            Preview
          </Button>
          <Button
            type="button"
            disabled={run.isPending}
            onClick={() => run.mutate(false)}
          >
            {run.isPending ? 'Calculating…' : 'Run evaluation'}
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          Preview computes the numbers without flagging the job or locking the
          bench. A real evaluation is a formal event.
        </p>

        {preview && (
          <div
            className={cn(
              'rounded-lg border p-3',
              preview.breached
                ? 'border-red-500/30 bg-red-500/[0.05]'
                : 'border-emerald-500/30 bg-emerald-500/[0.05]',
            )}
          >
            <div className="flex flex-wrap items-baseline gap-2">
              <span className="text-2xl font-semibold tabular-nums">
                {preview.ratio_percent}%
              </span>
              <span className="text-sm text-muted-foreground">
                of device value (threshold {preview.threshold_percent}%)
              </span>
              <Badge variant={preview.breached ? 'destructive' : 'success'}>
                {preview.breached ? 'Beyond economic repair' : 'Economic'}
              </Badge>
            </div>
            <dl className="mt-2 grid gap-x-4 gap-y-1 text-sm sm:grid-cols-2">
              <Row
                label="Parts"
                value={formatMoney(preview.parts_cost, preview.currency)}
              />
              <Row
                label="Labour"
                value={formatMoney(preview.labour_cost, preview.currency)}
              />
              <Row
                label="Total repair cost"
                value={formatMoney(preview.total_cost, preview.currency)}
              />
              <Row
                label="Device value"
                value={formatMoney(preview.device_value, preview.currency)}
              />
            </dl>
            <ul className="mt-2 list-inside list-disc text-xs text-muted-foreground">
              {preview.basis.map((b) => (
                <li key={b}>{b}</li>
              ))}
            </ul>
          </div>
        )}
      </CardContent>
    </Card>
  )
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-2">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="tabular-nums">{value}</dd>
    </div>
  )
}

// ---------------------------------------------------------------------------

const OUTCOMES: Array<[BerOutcome, string]> = [
  ['REPLACE_IW', 'In-warranty replacement'],
  ['REPLACE_TRADE_UP', 'Discounted trade-up'],
  ['SALVAGE', 'Customer took the salvage value'],
  ['DECLINED', 'Customer declined — return unrepaired'],
  ['REPAIR_ANYWAY', 'Customer insists on the repair'],
]

function AssessmentCard({
  job,
  ber,
  onDone,
}: {
  job: JobDetailWire
  ber: BerAssessment
  onDone: () => void
}) {
  const { can } = useAuth()
  const [notes, setNotes] = useState('')
  const [outcome, setOutcome] = useState<BerOutcome>('REPLACE_IW')
  const canCertify = can('job.ber.certify')

  const certify = useMutation({
    mutationFn: async () =>
      (await api.post(`/ber/${ber.id}/certify`, { notes })).data as {
        held: boolean
      },
    onSuccess: (r) => {
      toast[r.held ? 'info' : 'success'](
        r.held
          ? 'Sent to the Centre Manager for approval'
          : 'Certified Beyond Economic Repair',
      )
      onDone()
    },
    onError: (e) => toast.error(apiErrorMessage(e)),
  })

  const reject = useMutation({
    mutationFn: async () => (await api.post(`/ber/${ber.id}/reject`, { notes })).data,
    onSuccess: () => {
      toast.success('Back on the standard repair track')
      onDone()
    },
    onError: (e) => toast.error(apiErrorMessage(e)),
  })

  const record = useMutation({
    mutationFn: async () =>
      (await api.post(`/ber/${ber.id}/outcome`, { outcome, notes })).data,
    onSuccess: () => {
      toast.success('Customer decision recorded')
      onDone()
    },
    onError: (e) => toast.error(apiErrorMessage(e)),
  })

  return (
    <Card className="border-red-500/30">
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2">
          <ShieldAlert className="size-4 text-red-600" />
          Beyond Economic Repair
          <Badge variant={ber.status === 'CERTIFIED' ? 'destructive' : 'warning'}>
            {ber.status}
          </Badge>
          {ber.certificate_no && (
            <Badge variant="outline">{ber.certificate_no}</Badge>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <dl className="grid gap-x-4 gap-y-1 text-sm sm:grid-cols-2">
          <Row
            label="Repair cost"
            value={formatMoney(ber.total_cost, ber.currency)}
          />
          <Row
            label="Device value"
            value={formatMoney(ber.device_value, ber.currency)}
          />
          <Row label="Ratio" value={`${ber.ratio_percent}%`} />
          <Row label="Threshold" value={`${ber.threshold_percent}%`} />
        </dl>

        {job.tech_locked && (
          <p className="rounded-lg border border-amber-500/30 bg-amber-500/[0.06] p-3 text-sm">
            {job.tech_lock_reason}
          </p>
        )}

        {ber.decision_notes && (
          <p className="text-sm text-muted-foreground">{ber.decision_notes}</p>
        )}

        {canCertify && (
          <>
            <Textarea
              rows={2}
              placeholder="Review notes (required)…"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
            />
            {ber.status === 'FLAGGED' ? (
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  disabled={notes.trim().length < 10 || certify.isPending}
                  onClick={() => certify.mutate()}
                >
                  Certify BER
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  disabled={notes.trim().length < 10 || reject.isPending}
                  onClick={() => reject.mutate()}
                >
                  Reject — continue the repair
                </Button>
              </div>
            ) : (
              <div className="flex flex-wrap items-end gap-2">
                <div>
                  <p className="mb-1.5 text-sm font-medium">
                    Customer's decision
                  </p>
                  <Select
                    className="w-64"
                    value={outcome}
                    onChange={(e) => setOutcome(e.target.value as BerOutcome)}
                  >
                    {OUTCOMES.map(([v, label]) => (
                      <option key={v} value={v}>
                        {label}
                      </option>
                    ))}
                  </Select>
                </div>
                <Button
                  type="button"
                  disabled={record.isPending}
                  onClick={() => record.mutate()}
                >
                  Record decision
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() =>
                    window.open(
                      `/api/v1/ber/${ber.id}/certificate`,
                      '_blank',
                      'noopener',
                    )
                  }
                >
                  Certificate
                </Button>
              </div>
            )}
          </>
        )}

        {ber.outcome && (
          <p className="text-sm">
            <span className="text-muted-foreground">Customer chose: </span>
            {OUTCOMES.find(([v]) => v === ber.outcome)?.[1] ?? ber.outcome}
            {ber.customer_responded_at &&
              ` · ${formatDateTime(ber.customer_responded_at)}`}
          </p>
        )}
      </CardContent>
    </Card>
  )
}

// ---------------------------------------------------------------------------

function SwapCard({ job, onDone }: { job: JobDetailWire; onDone: () => void }) {
  const [unitId, setUnitId] = useState('')
  const [reason, setReason] = useState('')

  const units = useQuery({
    queryKey: ['swap-stock', job.branch_id],
    queryFn: async () =>
      (
        await api.get<PaginatedResponse<SwapUnit>>('/swap-stock', {
          params: { branch_id: job.branch_id, status: 'IN_STOCK', page_size: 100 },
        })
      ).data.data,
  })

  const swap = useMutation({
    mutationFn: async () =>
      (
        await api.post(`/jobs/${job.id}/swap`, {
          swap_unit_id: unitId,
          reason,
        })
      ).data as { held: boolean },
    onSuccess: (r) => {
      toast[r.held ? 'info' : 'success'](
        r.held
          ? 'Sent to the Centre Manager for approval'
          : 'Replacement issued — customer history moved to the new IMEI',
      )
      onDone()
    },
    onError: (e) => toast.error(apiErrorMessage(e)),
  })

  return (
    <Card>
      <CardHeader>
        <CardTitle>Issue a replacement from swap buffer stock</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {units.data?.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No replacement units are in this branch's swap buffer. Add one under
            Inventory → Swap stock, or transfer one in.
          </p>
        ) : (
          <>
            <Select value={unitId} onChange={(e) => setUnitId(e.target.value)}>
              <option value="">Select a replacement unit…</option>
              {(units.data ?? []).map((u) => (
                <option key={u.id} value={u.id}>
                  {u.model_label ?? u.category} · {u.imei_serial}
                  {u.color ? ` · ${u.color}` : ''}
                </option>
              ))}
            </Select>
            <Textarea
              rows={2}
              placeholder="Reason for the swap (goes on the record)…"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
            <Button
              type="button"
              className="self-start"
              disabled={!unitId || reason.trim().length < 5 || swap.isPending}
              onClick={() => swap.mutate()}
            >
              {swap.isPending ? 'Issuing…' : 'Issue replacement'}
            </Button>
            <p className="text-xs text-muted-foreground">
              The original IMEI is decommissioned and the customer's full repair
              history follows them to the replacement.
            </p>
          </>
        )}
      </CardContent>
    </Card>
  )
}

function HistoryList({ assessments }: { assessments: BerAssessment[] }) {
  if (assessments.length === 0) return null
  return (
    <Card>
      <CardHeader>
        <CardTitle>Earlier evaluations</CardTitle>
      </CardHeader>
      <CardContent>
        <ul className="flex flex-col gap-1 text-sm">
          {assessments.map((a) => (
            <li key={a.id} className="flex flex-wrap gap-2">
              <Badge variant="outline">{a.status}</Badge>
              <span className="tabular-nums">{a.ratio_percent}%</span>
              <span className="text-muted-foreground">
                {formatDateTime(a.flagged_at)}
              </span>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  )
}
