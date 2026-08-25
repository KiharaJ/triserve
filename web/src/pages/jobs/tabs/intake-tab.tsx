import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, Check, Droplets } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import type { PaginatedResponse } from '@triserve/shared'
import {
  ConditionMap,
  type ConditionMarkDraft,
} from '@/components/scms/condition-map'
import { SymptomPicker } from '@/components/scms/symptom-picker'
import { FormField } from '@/components/shared/form-field'
import { SignaturePad, type SignaturePadHandle } from '@/components/shared/signature-pad'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { api, apiErrorMessage } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { formatDateTime } from '@/lib/format'
import { cn } from '@/lib/utils'
import type {
  AttachmentWire,
  IntakeReadiness,
  JobCondition,
  JobDetailWire,
  SymptomNode,
} from '@/lib/types'

/**
 * The intake evidence pack (SCMS proposal Module 1, §2).
 *
 * Everything the counter owes before a device may leave the front desk, in
 * the order the proposal specifies: the visual condition map (step 3), the
 * cascading symptom tree (step 4), and the digital agreement — preliminary
 * estimate, terms, signature (step 5).
 *
 * The checklist at the top is the SAME rule the `intake_evidence_complete`
 * workflow guard enforces, fetched from the API rather than reimplemented
 * here, so the two can never disagree. Showing it up front matters: an agent
 * should see what is outstanding while the customer is still standing there,
 * not discover it when a transition is refused an hour later.
 */
export function IntakeTab({ job }: { job: JobDetailWire }) {
  const { can } = useAuth()
  const queryClient = useQueryClient()
  const canCapture = can('job.intake.capture')

  const readiness = useQuery({
    queryKey: ['intake-readiness', job.id],
    queryFn: async () =>
      (await api.get<IntakeReadiness>(`/jobs/${job.id}/intake-readiness`)).data,
  })

  function invalidate() {
    void queryClient.invalidateQueries({ queryKey: ['intake-readiness', job.id] })
    void queryClient.invalidateQueries({ queryKey: ['job', job.id] })
  }

  return (
    <div className="flex flex-col gap-4">
      <ReadinessCard readiness={readiness.data} />
      <ConditionCard job={job} disabled={!canCapture} onSaved={invalidate} />
      <BeforePhotosCard job={job} onSaved={invalidate} />
      <AgreementCard job={job} disabled={!canCapture} onSaved={invalidate} />
    </div>
  )
}

// ---------------------------------------------------------------------------

function ReadinessCard({ readiness }: { readiness?: IntakeReadiness }) {
  if (!readiness) return null

  const items: Array<[string, boolean]> = [
    ['Visual condition check', readiness.condition_captured],
    ['Before-photo on file', readiness.has_before_photo],
    ['Symptom recorded', readiness.symptom_selected],
    ['Customer signature', readiness.has_signature],
    ['Terms accepted', readiness.terms_accepted],
  ]

  return (
    <Card
      className={cn(
        readiness.ready
          ? 'border-emerald-500/30 bg-emerald-500/[0.04]'
          : 'border-amber-500/30 bg-amber-500/[0.04]',
      )}
    >
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          {readiness.ready ? (
            <>
              <Check className="size-4 text-emerald-600" /> Intake complete
            </>
          ) : (
            <>
              <AlertTriangle className="size-4 text-amber-600" /> Intake
              incomplete
            </>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        <ul className="grid gap-1.5 sm:grid-cols-2">
          {items.map(([label, done]) => (
            <li key={label} className="flex items-center gap-2 text-sm">
              <span
                className={cn(
                  'flex size-4 shrink-0 items-center justify-center rounded-full text-[10px]',
                  done
                    ? 'bg-emerald-600 text-white'
                    : 'border border-dashed border-muted-foreground/50',
                )}
              >
                {done ? '✓' : ''}
              </span>
              <span className={cn(!done && 'text-muted-foreground')}>
                {label}
              </span>
            </li>
          ))}
        </ul>
        {!readiness.ready && (
          <p className="text-xs text-muted-foreground">
            The job cannot move to diagnosis until these are done — a manager
            can override it on the record if the customer has already left.
          </p>
        )}
      </CardContent>
    </Card>
  )
}

// ---------------------------------------------------------------------------

function ConditionCard({
  job,
  disabled,
  onSaved,
}: {
  job: JobDetailWire
  disabled: boolean
  onSaved: () => void
}) {
  const queryClient = useQueryClient()
  const [marks, setMarks] = useState<ConditionMarkDraft[] | null>(null)
  const [liquid, setLiquid] = useState<boolean | null>(null)

  const condition = useQuery({
    queryKey: ['job-condition', job.id],
    queryFn: async () =>
      (await api.get<JobCondition>(`/jobs/${job.id}/condition`)).data,
  })

  // Seed the local draft ONCE from the server state. Re-seeding on every
  // refetch would throw away edits in progress the moment anything else on
  // the page invalidated a query.
  useEffect(() => {
    if (condition.data && marks === null) {
      setMarks(
        condition.data.marks.map((m) => ({
          zone_id: m.zone_id,
          damage: m.damage,
          severity: m.severity,
          note: m.note ?? undefined,
        })),
      )
      setLiquid(condition.data.liquid_indicator_tripped)
    }
  }, [condition.data, marks])

  const save = useMutation({
    mutationFn: async () =>
      (
        await api.put<JobCondition>(`/jobs/${job.id}/condition`, {
          marks: marks ?? [],
          ...(liquid === null ? {} : { liquid_indicator_tripped: liquid }),
        })
      ).data,
    onSuccess: () => {
      toast.success('Condition recorded')
      void queryClient.invalidateQueries({ queryKey: ['job-condition', job.id] })
      onSaved()
    },
    onError: (e) => toast.error(apiErrorMessage(e)),
  })

  if (condition.isPending) {
    return <p className="text-sm text-muted-foreground">Loading condition map…</p>
  }
  if (!condition.data) return null

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2">
          Device condition at intake
          {condition.data.captured_at ? (
            <Badge variant="success">
              Checked {formatDateTime(condition.data.captured_at)}
            </Badge>
          ) : (
            <Badge variant="warning">Not checked</Badge>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <ConditionMap
          zones={condition.data.zones}
          marks={marks ?? []}
          onChange={setMarks}
          disabled={disabled}
        />

        <div className="flex flex-wrap items-center gap-2 rounded-lg border p-3">
          <Droplets className="size-4 text-muted-foreground" />
          <span className="text-sm font-medium">Liquid damage indicator</span>
          {/* Tri-state, mirroring the column: "not checked" and "clean" must
              never look the same in a warranty dispute. */}
          {(
            [
              [null, 'Not checked'],
              [false, 'Clean'],
              [true, 'Tripped'],
            ] as Array<[boolean | null, string]>
          ).map(([v, label]) => (
            <Button
              key={label}
              type="button"
              size="sm"
              variant={liquid === v ? 'default' : 'outline'}
              disabled={disabled}
              onClick={() => setLiquid(v)}
            >
              {label}
            </Button>
          ))}
        </div>

        {!disabled && (
          <div className="flex items-center gap-2">
            <Button
              type="button"
              disabled={save.isPending || marks === null}
              onClick={() => save.mutate()}
            >
              {save.isPending ? 'Saving…' : 'Save condition report'}
            </Button>
            <p className="text-xs text-muted-foreground">
              Saving with no marks records that the device was checked and found
              unmarked.
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  )
}

// ---------------------------------------------------------------------------

/**
 * §2 step 3's "at least one before-photo" — its own card because it was
 * previously capturable ONLY at booking (the intake wizard's Photos step).
 * A job booked without one, or with one that failed to upload, had NO way
 * to add it afterward short of an admin override or the API directly.
 */
function BeforePhotosCard({
  job,
  onSaved,
}: {
  job: JobDetailWire
  onSaved: () => void
}) {
  const { can } = useAuth()
  const queryClient = useQueryClient()

  // Same query + cache key as AttachmentsTab's — GET /attachments has no
  // `kind` filter (a job carries a handful at most, per its own docstring),
  // so both tabs share one fetch and invalidate each other's cache.
  const attachments = useQuery({
    queryKey: ['attachments', 'JOB', job.id],
    queryFn: async () =>
      (
        await api.get<PaginatedResponse<AttachmentWire>>('/attachments', {
          params: { owner_type: 'JOB', owner_id: job.id },
        })
      ).data.data,
    enabled: can('attachment.read'),
  })

  const upload = useMutation({
    mutationFn: async (files: File[]) => {
      for (const file of files) {
        const fd = new FormData()
        fd.append('file', file)
        fd.append('owner_type', 'JOB')
        fd.append('owner_id', job.id)
        fd.append('kind', 'PHOTO_BEFORE')
        await api.post('/attachments', fd)
      }
    },
    onSuccess: async () => {
      toast.success('Before-photo uploaded')
      await queryClient.invalidateQueries({
        queryKey: ['attachments', 'JOB', job.id],
      })
      onSaved()
    },
    onError: (e) => toast.error(apiErrorMessage(e)),
  })

  const photos = (attachments.data ?? []).filter((a) => a.kind === 'PHOTO_BEFORE')

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2">
          Before-photos
          {photos.length > 0 ? (
            <Badge variant="success">{photos.length} on file</Badge>
          ) : (
            <Badge variant="warning">None yet</Badge>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {photos.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {photos.map((a) => (
              <a key={a.id} href={a.url} target="_blank" rel="noreferrer">
                <img
                  src={a.url}
                  alt={a.file_name}
                  className="size-24 rounded-md border object-cover"
                />
              </a>
            ))}
          </div>
        )}
        {can('attachment.create') && (
          <FormField label="Upload before-photos" htmlFor="before-photos">
            <Input
              id="before-photos"
              type="file"
              accept="image/*"
              multiple
              disabled={upload.isPending}
              onChange={(e) => {
                if (e.target.files) upload.mutate(Array.from(e.target.files))
                e.target.value = ''
              }}
            />
          </FormField>
        )}
      </CardContent>
    </Card>
  )
}

// ---------------------------------------------------------------------------

function AgreementCard({
  job,
  disabled,
  onSaved,
}: {
  job: JobDetailWire
  disabled: boolean
  onSaved: () => void
}) {
  const queryClient = useQueryClient()
  const padRef = useRef<SignaturePadHandle>(null)
  const [hasInk, setHasInk] = useState(false)
  const [symptom, setSymptom] = useState<SymptomNode | null>(null)
  const [estimate, setEstimate] = useState('')

  const attachments = useQuery({
    queryKey: ['attachments', 'JOB', job.id],
    queryFn: async () =>
      (
        await api.get<PaginatedResponse<AttachmentWire>>('/attachments', {
          params: { owner_type: 'JOB', owner_id: job.id, page_size: 100 },
        })
      ).data.data,
  })

  const existingSignature = attachments.data?.find((a) => a.kind === 'SIGNATURE')

  const accept = useMutation({
    mutationFn: async () => {
      // The signature has to EXIST before terms can reference it — the API
      // verifies the attachment belongs to this job and really is a signature,
      // so a terms stamp can never stand on nothing.
      let signatureId = existingSignature?.id
      if (!signatureId) {
        if (!padRef.current || padRef.current.isEmpty()) {
          throw new Error('Capture the customer’s signature first')
        }
        const uploaded = await api.post<AttachmentWire>(
          '/attachments/signature',
          {
            owner_id: job.id,
            data_uri: padRef.current.toDataUrl(),
          },
        )
        signatureId = uploaded.data.id
      }

      return (
        await api.post<{ ready: boolean }>(`/jobs/${job.id}/terms`, {
          signature_attachment_id: signatureId,
          ...(symptom ? { symptom_node_id: symptom.id } : {}),
          ...(estimate.trim()
            ? {
                // Whole shillings on screen → minor units on the wire, the
                // money convention everywhere in this app.
                estimate_amount: String(
                  Math.round(Number(estimate.replace(/[^\d.]/g, '')) * 100),
                ),
                estimate_currency: 'TZS',
              }
            : {}),
        })
      ).data
    },
    onSuccess: () => {
      toast.success('Terms accepted and signature filed')
      void queryClient.invalidateQueries({
        queryKey: ['attachments', 'JOB', job.id],
      })
      onSaved()
    },
    onError: (e) =>
      toast.error(e instanceof Error ? e.message : apiErrorMessage(e)),
  })

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2">
          Reported symptom & customer agreement
          {job.terms_accepted_at ? (
            <Badge variant="success">
              Accepted {formatDateTime(job.terms_accepted_at)}
            </Badge>
          ) : (
            <Badge variant="warning">Not accepted</Badge>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div>
          <p className="mb-1.5 text-sm font-medium">Symptom</p>
          <SymptomPicker
            category={job.device.category as never}
            value={symptom}
            onChange={(node) => {
              setSymptom(node)
              // Pre-fill the counter's estimate from the tree, which is what
              // the indicative price on each leaf is for. Still editable —
              // it is an estimate, not a quote.
              if (node?.estimate_amount) {
                setEstimate(String(Number(node.estimate_amount) / 100))
              }
            }}
            disabled={disabled || job.terms_accepted_at !== null}
          />
          {job.symptom_node_id && !symptom && (
            <p className="mt-1 text-xs text-muted-foreground">
              A symptom is already recorded on this job. Pick another to replace
              it.
            </p>
          )}
        </div>

        <div className="max-w-xs">
          <p className="mb-1.5 text-sm font-medium">
            Preliminary estimate (TZS)
          </p>
          <Input
            inputMode="numeric"
            placeholder="e.g. 450000"
            value={estimate}
            disabled={disabled || job.terms_accepted_at !== null}
            onChange={(e) => setEstimate(e.target.value)}
          />
          <p className="mt-1 text-xs text-muted-foreground">
            Shown to the customer before they sign. Not a quote — the formal
            quote comes after diagnosis.
          </p>
        </div>

        <div>
          <p className="mb-1.5 text-sm font-medium">Customer signature</p>
          {existingSignature ? (
            <p className="text-sm text-muted-foreground">
              A signature is already on file for this job.
            </p>
          ) : (
            <SignaturePad ref={padRef} onChange={setHasInk} />
          )}
          <p className="mt-1 text-xs text-muted-foreground">
            By signing, the customer accepts the service terms, the data-loss
            disclaimer and the disposal policy.
          </p>
        </div>

        {!disabled && !job.terms_accepted_at && (
          <Button
            type="button"
            className="self-start"
            disabled={
              accept.isPending || (!existingSignature && !hasInk)
            }
            onClick={() => accept.mutate()}
          >
            {accept.isPending ? 'Filing…' : 'Record agreement'}
          </Button>
        )}
      </CardContent>
    </Card>
  )
}
