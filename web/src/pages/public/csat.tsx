import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Loader2, Star } from 'lucide-react'
import { useState } from 'react'
import { useParams } from 'react-router-dom'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { apiErrorMessage } from '@/lib/api'
import { publicApi } from '@/lib/public-api'
import type { PublicCsatWire } from '@/lib/types'
import { Outcome, PublicShell } from './quote-approval'

/** 1–5, worst to best. The wording is what gets reported on, so it is fixed. */
const SCORES: { value: number; label: string }[] = [
  { value: 1, label: 'Very poor' },
  { value: 2, label: 'Poor' },
  { value: 3, label: 'Okay' },
  { value: 4, label: 'Good' },
  { value: 5, label: 'Excellent' },
]

/**
 * /csat/:token — the customer satisfaction survey (SCMS proposal Module 6,
 * §7 step 5).
 *
 * UNAUTHENTICATED, same terms as the quote page: the token is the credential
 * and grants access to exactly one survey. Kept to one required tap (the
 * score) with the comment optional — every extra field costs responses, and
 * an unanswered survey measures nothing.
 */
export function PublicCsatPage() {
  const { token = '' } = useParams()
  const queryClient = useQueryClient()
  const [score, setScore] = useState<number | null>(null)
  const [comment, setComment] = useState('')

  const surveyKey = ['public-csat', token]
  const {
    data: survey,
    isPending,
    error,
  } = useQuery({
    queryKey: surveyKey,
    queryFn: async () => {
      const res = await publicApi.get<PublicCsatWire>(`/public/csat/${token}`)
      return res.data
    },
    retry: false,
  })

  const submit = useMutation({
    mutationFn: async () => {
      const res = await publicApi.post<PublicCsatWire>(`/public/csat/${token}`, {
        score,
        ...(comment.trim() ? { comment: comment.trim() } : {}),
      })
      return res.data
    },
    onSuccess: (updated) => queryClient.setQueryData(surveyKey, updated),
  })

  if (isPending) {
    return (
      <PublicShell>
        <div className="flex items-center justify-center gap-2 py-16 text-muted-foreground">
          <Loader2 className="size-4 animate-spin" />
          Loading…
        </div>
      </PublicShell>
    )
  }

  if (error || !survey) {
    return (
      <PublicShell>
        <Outcome
          tone="error"
          title="This survey link is no longer valid"
          detail={
            error
              ? apiErrorMessage(error)
              : 'It may have expired, or already been answered.'
          }
        />
      </PublicShell>
    )
  }

  if (survey.answered) {
    return (
      <PublicShell company={survey.company} branch={survey.branch}>
        <Outcome
          tone="success"
          title="Thank you for your feedback"
          detail="Your answer has been recorded — it goes straight to the branch manager."
        />
      </PublicShell>
    )
  }

  return (
    <PublicShell company={survey.company} branch={survey.branch}>
      <div className="space-y-6">
        <div>
          <h1 className="text-xl font-semibold">How did we do?</h1>
          <p className="text-sm text-muted-foreground">
            {survey.device} · Job {survey.job_no}
          </p>
        </div>

        <div>
          <p className="mb-3 text-sm font-medium">
            Rate the service you received
          </p>
          <div className="flex flex-wrap gap-2">
            {SCORES.map((s) => {
              const selected = score !== null && s.value <= score
              return (
                <button
                  key={s.value}
                  type="button"
                  aria-label={s.label}
                  aria-pressed={score === s.value}
                  onClick={() => setScore(s.value)}
                  className="flex flex-col items-center gap-1 rounded-md border px-3 py-2 text-xs transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                >
                  <Star
                    className={`size-6 ${
                      selected
                        ? 'fill-amber-400 text-amber-500'
                        : 'text-muted-foreground'
                    }`}
                  />
                  {s.label}
                </button>
              )
            })}
          </div>
        </div>

        <div>
          <label htmlFor="csat-comment" className="mb-2 block text-sm font-medium">
            Anything you would like to add?{' '}
            <span className="font-normal text-muted-foreground">(optional)</span>
          </label>
          <Textarea
            id="csat-comment"
            rows={4}
            maxLength={2000}
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            placeholder="Tell us what went well, or what we could do better."
          />
        </div>

        {submit.isError && (
          <p className="text-sm text-destructive">
            {apiErrorMessage(submit.error)}
          </p>
        )}

        <Button
          size="lg"
          disabled={score === null || submit.isPending}
          onClick={() => submit.mutate()}
        >
          {submit.isPending && <Loader2 className="mr-1 size-4 animate-spin" />}
          Send feedback
        </Button>
      </div>
    </PublicShell>
  )
}
