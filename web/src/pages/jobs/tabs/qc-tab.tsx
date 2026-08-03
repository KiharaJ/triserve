import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { api, apiErrorMessage } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { formatDateTime } from '@/lib/format'
import { cn } from '@/lib/utils'
import type { JobDetailWire, JobQcPanel, QcCheckResult } from '@/lib/types'

/**
 * Bench declaration + the quality gate (SCMS proposal Module 2, §3).
 *
 *   IN_REPAIR → QC  "Forces input of actual labor hours and technician repair
 *                    notes."
 *   QC → READY      "Senior Quality Assurer approves diagnostic checklist.
 *                    Requires entry of hardware calibration logs & software
 *                    flash checks."
 *   QC → DIAGNOSIS  "Requires mandatory failure reason log; routes back to the
 *                    same tech."
 *
 * The checklist is per device class, and results are recorded per ATTEMPT —
 * a unit that failed water-resistance twice must never look like one that
 * passed first time, which is exactly what the rework counter shows.
 */
export function QcTab({ job }: { job: JobDetailWire }) {
  const { can } = useAuth()
  const queryClient = useQueryClient()

  const panel = useQuery({
    queryKey: ['job-qc', job.id],
    queryFn: async () =>
      (await api.get<JobQcPanel>(`/jobs/${job.id}/qc`)).data,
  })

  function refresh() {
    void queryClient.invalidateQueries({ queryKey: ['job-qc', job.id] })
    void queryClient.invalidateQueries({ queryKey: ['job', job.id] })
  }

  if (panel.isPending) {
    return <p className="text-sm text-muted-foreground">Loading QC panel…</p>
  }
  if (!panel.data) return null

  return (
    <div className="flex flex-col gap-4">
      <WorkCard job={job} panel={panel.data} onSaved={refresh} />
      {can('job.qc.record') && (
        <ChecklistCard job={job} panel={panel.data} onSaved={refresh} />
      )}
      {can('job.qc.approve') && (
        <DecisionCard job={job} panel={panel.data} onDone={refresh} />
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------

function WorkCard({
  job,
  panel,
  onSaved,
}: {
  job: JobDetailWire
  panel: JobQcPanel
  onSaved: () => void
}) {
  const { can } = useAuth()
  const [hours, setHours] = useState(panel.labour_hours ?? '')
  const [report, setReport] = useState(panel.tech_report ?? '')

  const save = useMutation({
    mutationFn: async () =>
      (
        await api.patch(`/jobs/${job.id}/work`, {
          labour_hours: Number(hours),
          tech_report: report,
        })
      ).data,
    onSuccess: () => {
      toast.success('Work declared')
      onSaved()
    },
    onError: (e) => toast.error(apiErrorMessage(e)),
  })

  const complete = Number(panel.labour_hours) > 0 && Boolean(panel.tech_report)

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2">
          Declared work
          {complete ? (
            <Badge variant="success">Recorded</Badge>
          ) : (
            <Badge variant="warning">Required before QC</Badge>
          )}
          {job.tech_locked && (
            <Badge variant="destructive">
              {job.tech_lock_reason ?? 'Bench locked'}
            </Badge>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <div className="grid gap-3 sm:grid-cols-[10rem_1fr]">
          <div>
            <p className="mb-1.5 text-sm font-medium">Actual labour hours</p>
            <Input
              inputMode="decimal"
              placeholder="e.g. 1.50"
              value={hours}
              disabled={!can('job.update') || job.tech_locked}
              onChange={(e) => setHours(e.target.value)}
            />
          </div>
          <div>
            <p className="mb-1.5 text-sm font-medium">Repair note</p>
            <Textarea
              rows={3}
              placeholder="What was diagnosed, what was done, what was replaced…"
              value={report}
              disabled={!can('job.update') || job.tech_locked}
              onChange={(e) => setReport(e.target.value)}
            />
          </div>
        </div>
        {can('job.update') && !job.tech_locked && (
          <Button
            type="button"
            className="self-start"
            disabled={save.isPending || !hours || report.trim().length < 3}
            onClick={() => save.mutate()}
          >
            {save.isPending ? 'Saving…' : 'Declare work'}
          </Button>
        )}
      </CardContent>
    </Card>
  )
}

// ---------------------------------------------------------------------------

const RESULTS: QcCheckResult[] = ['PASS', 'FAIL', 'NA']

const RESULT_STYLE: Record<QcCheckResult, string> = {
  PASS: 'bg-emerald-600 text-white hover:bg-emerald-700',
  FAIL: 'bg-red-600 text-white hover:bg-red-700',
  NA: 'bg-muted text-muted-foreground',
}

function ChecklistCard({
  job,
  panel,
  onSaved,
}: {
  job: JobDetailWire
  panel: JobQcPanel
  onSaved: () => void
}) {
  const [draft, setDraft] = useState<
    Record<string, { result: QcCheckResult; value: string; note: string }>
  >({})

  // Re-seed whenever the ATTEMPT changes: a rejection starts a fresh round,
  // and carrying the previous attempt's answers over would defeat the point of
  // recording attempts separately.
  useEffect(() => {
    const seeded: typeof draft = {}
    for (const line of panel.lines) {
      if (line.result) {
        seeded[line.item_id] = {
          result: line.result,
          value: line.value ?? '',
          note: line.note ?? '',
        }
      }
    }
    setDraft(seeded)
  }, [panel.attempt_no, panel.lines])

  const save = useMutation({
    mutationFn: async () =>
      (
        await api.put(`/jobs/${job.id}/qc-checks`, {
          checks: Object.entries(draft).map(([item_id, v]) => ({
            item_id,
            result: v.result,
            value: v.value || undefined,
            note: v.note || undefined,
          })),
        })
      ).data,
    onSuccess: () => {
      toast.success('QC results recorded')
      onSaved()
    },
    onError: (e) => toast.error(apiErrorMessage(e)),
  })

  if (panel.lines.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Calibration checklist</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            No QC checks are configured for {panel.category} devices. An
            administrator can add them under Configuration.
          </p>
        </CardContent>
      </Card>
    )
  }

  const outstanding = panel.lines.filter(
    (l) => l.blocking && draft[l.item_id]?.result !== 'PASS',
  ).length

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2">
          Calibration & flash checks
          <Badge variant="outline">Attempt {panel.attempt_no}</Badge>
          {outstanding > 0 ? (
            <Badge variant="warning">{outstanding} outstanding</Badge>
          ) : (
            <Badge variant="success">All blocking checks passed</Badge>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <ul className="flex flex-col gap-2">
          {panel.lines.map((line) => {
            const entry = draft[line.item_id]
            return (
              <li key={line.item_id} className="rounded-lg border p-3">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="text-sm font-medium">
                      {line.label}
                      {!line.blocking && (
                        <span className="ml-2 text-xs font-normal text-muted-foreground">
                          advisory
                        </span>
                      )}
                    </p>
                    {line.help && (
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        {line.help}
                      </p>
                    )}
                  </div>
                  <div className="flex gap-1">
                    {RESULTS.map((r) => (
                      <Button
                        key={r}
                        type="button"
                        size="sm"
                        variant="outline"
                        className={cn(entry?.result === r && RESULT_STYLE[r])}
                        onClick={() =>
                          setDraft((d) => ({
                            ...d,
                            [line.item_id]: {
                              result: r,
                              value: d[line.item_id]?.value ?? '',
                              note: d[line.item_id]?.note ?? '',
                            },
                          }))
                        }
                      >
                        {r === 'NA' ? 'N/A' : r}
                      </Button>
                    ))}
                  </div>
                </div>
                {line.requires_value && (
                  <Input
                    className="mt-2 h-8 max-w-xs"
                    placeholder="Measured reading (required to pass)"
                    value={entry?.value ?? ''}
                    onChange={(e) =>
                      setDraft((d) => ({
                        ...d,
                        [line.item_id]: {
                          result: d[line.item_id]?.result ?? 'PASS',
                          value: e.target.value,
                          note: d[line.item_id]?.note ?? '',
                        },
                      }))
                    }
                  />
                )}
                {line.requires_attachment && (
                  <p className="mt-1.5 text-xs text-amber-600 dark:text-amber-400">
                    Upload the raw log file to this job's attachments before
                    approving.
                  </p>
                )}
              </li>
            )
          })}
        </ul>
        <Button
          type="button"
          className="self-start"
          disabled={save.isPending || Object.keys(draft).length === 0}
          onClick={() => save.mutate()}
        >
          {save.isPending ? 'Saving…' : 'Save results'}
        </Button>
      </CardContent>
    </Card>
  )
}

// ---------------------------------------------------------------------------

function DecisionCard({
  job,
  panel,
  onDone,
}: {
  job: JobDetailWire
  panel: JobQcPanel
  onDone: () => void
}) {
  const [reason, setReason] = useState('')

  const approve = useMutation({
    mutationFn: async () =>
      (await api.post(`/jobs/${job.id}/qc-approve`, {})).data,
    onSuccess: () => {
      toast.success('QC approved — job moved to ready for collection')
      onDone()
    },
    onError: (e) => toast.error(apiErrorMessage(e)),
  })

  const reject = useMutation({
    mutationFn: async () =>
      (await api.post(`/jobs/${job.id}/qc-reject`, { reason })).data,
    onSuccess: () => {
      toast.success('Sent back to the bench')
      setReason('')
      onDone()
    },
    onError: (e) => toast.error(apiErrorMessage(e)),
  })

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2">
          Quality decision
          {panel.qc_reject_count > 0 && (
            <Badge variant="warning">
              {panel.qc_reject_count} previous rejection
              {panel.qc_reject_count === 1 ? '' : 's'}
            </Badge>
          )}
          {panel.qc_approved_at && (
            <Badge variant="success">
              Approved {formatDateTime(panel.qc_approved_at)}
            </Badge>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {panel.qc_failure_reason && (
          <div className="rounded-lg border border-amber-500/30 bg-amber-500/[0.06] p-3 text-sm">
            <p className="font-medium">Last rejection reason</p>
            <p className="mt-0.5 text-muted-foreground">
              {panel.qc_failure_reason}
            </p>
          </div>
        )}

        {!panel.can_approve && panel.approve_blocked_reason && (
          <p className="rounded-lg border border-dashed p-3 text-sm text-muted-foreground">
            {panel.approve_blocked_reason}
          </p>
        )}

        <div>
          <p className="mb-1.5 text-sm font-medium">
            Failure reason (required to reject)
          </p>
          <Textarea
            rows={2}
            placeholder="What failed, and what the bench must redo…"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
        </div>

        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            disabled={!panel.can_approve || approve.isPending}
            onClick={() => approve.mutate()}
          >
            {approve.isPending ? 'Approving…' : 'Approve & mark ready'}
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={reason.trim().length < 5 || reject.isPending}
            onClick={() => reject.mutate()}
          >
            {reject.isPending ? 'Rejecting…' : 'Reject to bench'}
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}
