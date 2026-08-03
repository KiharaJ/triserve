import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { CheckCircle2, Loader2, XCircle } from 'lucide-react'
import { useState } from 'react'
import { useParams } from 'react-router-dom'
import { Button } from '@/components/ui/button'
import { apiErrorMessage } from '@/lib/api'
import { formatDateTime, formatMoney } from '@/lib/format'
import { publicApi } from '@/lib/public-api'
import type { PublicQuoteWire } from '@/lib/types'

/**
 * /quote/:token — the customer approving or declining an out-of-warranty
 * repair quote (SCMS proposal Module 5, §6).
 *
 * UNAUTHENTICATED and outside the AppShell: the visitor has no TriServe
 * account. The token in the URL is the whole credential, so the page renders
 * nothing until the API has validated it, and it never asks who they are.
 *
 * The decision is IRREVERSIBLE and burns the link, which is why it goes
 * through an explicit confirm step rather than firing on the first click —
 * a mis-tap must not decline a repair.
 */
export function PublicQuotePage() {
  const { token = '' } = useParams()
  const queryClient = useQueryClient()
  const [confirming, setConfirming] = useState<'APPROVED' | 'DECLINED' | null>(
    null,
  )

  const quoteKey = ['public-quote', token]
  const {
    data: quote,
    isPending,
    error,
  } = useQuery({
    queryKey: quoteKey,
    queryFn: async () => {
      const res = await publicApi.get<PublicQuoteWire>(`/public/quote/${token}`)
      return res.data
    },
    retry: false,
  })

  const decide = useMutation({
    mutationFn: async (decision: 'APPROVED' | 'DECLINED') => {
      const res = await publicApi.post<PublicQuoteWire>(
        `/public/quote/${token}/decision`,
        { decision },
      )
      return res.data
    },
    onSuccess: (updated) => {
      queryClient.setQueryData(quoteKey, updated)
      setConfirming(null)
    },
  })

  if (isPending) {
    return (
      <PublicShell>
        <div className="flex items-center justify-center gap-2 py-16 text-muted-foreground">
          <Loader2 className="size-4 animate-spin" />
          Loading your quote…
        </div>
      </PublicShell>
    )
  }

  if (error || !quote) {
    return (
      <PublicShell>
        <Outcome
          tone="error"
          title="This link is no longer valid"
          detail={
            error
              ? apiErrorMessage(error)
              : 'It may have expired, or already been used. Please contact the service centre.'
          }
        />
      </PublicShell>
    )
  }

  if (quote.decided) {
    return (
      <PublicShell company={quote.company} branch={quote.branch}>
        <Outcome
          tone={quote.decided === 'APPROVED' ? 'success' : 'error'}
          title={
            quote.decided === 'APPROVED'
              ? 'Thank you — the repair is approved'
              : 'You declined this repair'
          }
          detail={
            quote.decided === 'APPROVED'
              ? `We have started work on ${quote.device}. We will let you know as soon as it is ready.`
              : `We will not carry out the work on ${quote.device}. Contact the service centre if you change your mind.`
          }
        />
      </PublicShell>
    )
  }

  return (
    <PublicShell company={quote.company} branch={quote.branch}>
      <div className="space-y-6">
        <div>
          <h1 className="text-xl font-semibold">Repair quote</h1>
          <p className="text-sm text-muted-foreground">
            {quote.device}
            {quote.job_no && ` · Job ${quote.job_no}`} · Quote{' '}
            {quote.invoice_no}
          </p>
        </div>

        <div className="rounded-lg border">
          <table className="w-full text-sm">
            <thead className="border-b bg-muted/40 text-left">
              <tr>
                <th className="p-3 font-medium">Item</th>
                <th className="w-16 p-3 text-right font-medium">Qty</th>
                <th className="w-32 p-3 text-right font-medium">Amount</th>
              </tr>
            </thead>
            <tbody>
              {quote.lines.map((line, i) => (
                <tr key={`${line.description}-${i}`} className="border-b last:border-0">
                  <td className="p-3">{line.description}</td>
                  <td className="p-3 text-right tabular-nums">{line.qty}</td>
                  <td className="p-3 text-right tabular-nums">
                    {formatMoney(line.line_total, quote.currency)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <dl className="space-y-1 border-t p-3 text-sm">
            <Row label="Subtotal" value={formatMoney(quote.subtotal, quote.currency)} />
            {quote.discount !== '0' && (
              <Row
                label="Discount"
                value={`− ${formatMoney(quote.discount, quote.currency)}`}
              />
            )}
            <Row label="Tax" value={formatMoney(quote.tax, quote.currency)} />
            <div className="flex justify-between border-t pt-2 text-base font-semibold">
              <dt>Total</dt>
              <dd className="tabular-nums">
                {formatMoney(quote.total, quote.currency)}
              </dd>
            </div>
          </dl>
        </div>

        <p className="text-xs text-muted-foreground">
          This quote is valid until {formatDateTime(quote.expires_at)}.
        </p>

        {decide.isError && (
          <p className="text-sm text-destructive">
            {apiErrorMessage(decide.error)}
          </p>
        )}

        {confirming ? (
          <div className="space-y-3 rounded-lg border border-dashed p-4">
            <p className="text-sm font-medium">
              {confirming === 'APPROVED'
                ? `Approve this repair for ${formatMoney(quote.total, quote.currency)}?`
                : 'Decline this repair?'}
            </p>
            <p className="text-sm text-muted-foreground">
              This is final — the link stops working once you decide.
            </p>
            <div className="flex flex-wrap gap-2">
              <Button
                variant={confirming === 'APPROVED' ? 'default' : 'destructive'}
                disabled={decide.isPending}
                onClick={() => decide.mutate(confirming)}
              >
                {decide.isPending && (
                  <Loader2 className="mr-1 size-4 animate-spin" />
                )}
                Yes, {confirming === 'APPROVED' ? 'approve' : 'decline'}
              </Button>
              <Button
                variant="ghost"
                disabled={decide.isPending}
                onClick={() => setConfirming(null)}
              >
                Go back
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex flex-wrap gap-2">
            <Button size="lg" onClick={() => setConfirming('APPROVED')}>
              Approve the repair
            </Button>
            <Button
              size="lg"
              variant="outline"
              onClick={() => setConfirming('DECLINED')}
            >
              Decline
            </Button>
          </div>
        )}
      </div>
    </PublicShell>
  )
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="tabular-nums">{value}</dd>
    </div>
  )
}

/**
 * The chrome shared by both public pages. Deliberately minimal: no nav, no
 * account menu, nothing the visitor cannot use.
 */
export function PublicShell({
  company,
  branch,
  children,
}: {
  company?: string
  branch?: string
  children: React.ReactNode
}) {
  return (
    <div className="min-h-dvh bg-muted/30 px-4 py-10">
      <div className="mx-auto w-full max-w-2xl space-y-6 rounded-xl border bg-background p-6 shadow-sm sm:p-8">
        {company && (
          <div className="border-b pb-4">
            <p className="font-semibold">{company}</p>
            {branch && (
              <p className="text-sm text-muted-foreground">{branch}</p>
            )}
          </div>
        )}
        {children}
      </div>
    </div>
  )
}

export function Outcome({
  tone,
  title,
  detail,
}: {
  tone: 'success' | 'error'
  title: string
  detail: string
}) {
  const Icon = tone === 'success' ? CheckCircle2 : XCircle
  return (
    <div className="space-y-3 py-8 text-center">
      <Icon
        className={`mx-auto size-10 ${
          tone === 'success' ? 'text-emerald-600' : 'text-destructive'
        }`}
      />
      <h1 className="text-lg font-semibold">{title}</h1>
      <p className="text-sm text-muted-foreground">{detail}</p>
    </div>
  )
}
