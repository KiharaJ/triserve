import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { api, apiErrorMessage } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { formatDateTime } from '@/lib/format'
import type { CollectionOtp, JobDetailWire } from '@/lib/types'

/**
 * Handover tab (SCMS proposal Module 6, §7) — the collection PIN that gates
 * releasing the device to the customer.
 *
 * The full PIN is NEVER shown here. It is hashed on the server and delivered
 * only to the customer by SMS; the counter sees the last two digits, which is
 * enough to confirm they are reading the right message aloud without letting
 * a member of staff release a device on their own say-so.
 */
export function HandoverTab({ job }: { job: JobDetailWire }) {
  const { can } = useAuth()
  const queryClient = useQueryClient()
  const [code, setCode] = useState('')
  const [sendTo, setSendTo] = useState('')

  const canIssue = can('job.collection.otp.issue')
  const canVerify = can('job.collection.otp.verify')

  const otpKey = ['collection-otp', job.id]
  const otp = useQuery({
    queryKey: otpKey,
    queryFn: async () =>
      (await api.get<CollectionOtp | null>(`/jobs/${job.id}/collection-otp`))
        .data,
  })

  const invalidate = async () => {
    await queryClient.invalidateQueries({ queryKey: otpKey })
    // The dispatch guard reads this PIN, so the job's allowed moves change
    // with it — refresh the job or the "Dispatch" button stays stale.
    await queryClient.invalidateQueries({ queryKey: ['job', job.id] })
  }

  const issue = useMutation({
    mutationFn: async () =>
      api.post(`/jobs/${job.id}/collection-otp`, {
        ...(sendTo.trim() ? { send_to: sendTo.trim() } : {}),
      }),
    onSuccess: async () => {
      toast.success('PIN sent to the customer')
      setSendTo('')
      setCode('')
      await invalidate()
    },
    onError: (e) => toast.error(apiErrorMessage(e)),
  })

  const verify = useMutation({
    mutationFn: async () =>
      api.post(`/jobs/${job.id}/collection-otp/verify`, { code }),
    onSuccess: async () => {
      toast.success('PIN verified — the device may be released')
      setCode('')
      await invalidate()
    },
    onError: (e) => toast.error(apiErrorMessage(e)),
  })

  if (otp.isPending) {
    return <p className="text-sm text-muted-foreground">Loading…</p>
  }
  if (otp.isError) {
    return <p className="text-sm text-destructive">{apiErrorMessage(otp.error)}</p>
  }

  const pin = otp.data

  return (
    <div className="max-w-xl space-y-4">
      {!pin && (
        <p className="text-sm text-muted-foreground">
          No collection PIN has been issued yet. One is sent automatically when
          the job reaches Ready.
        </p>
      )}

      {pin && (
        <div className="space-y-2 rounded-lg border p-4 text-sm">
          <div className="flex items-center gap-2">
            <span className="font-medium">Collection PIN</span>
            <span className="font-mono text-muted-foreground">••••{pin.code_hint}</span>
            {pin.verified_at ? (
              <Badge variant="success">Verified</Badge>
            ) : pin.active ? (
              <Badge variant="warning">Awaiting the customer</Badge>
            ) : (
              <Badge variant="destructive">
                {pin.void_reason ?? 'No longer valid'}
              </Badge>
            )}
          </div>
          <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-muted-foreground">
            <dt>Sent to</dt>
            <dd className="text-foreground">{pin.sent_to ?? '—'}</dd>
            <dt>Sent at</dt>
            <dd className="text-foreground">
              {pin.sent_at ? formatDateTime(pin.sent_at) : '—'}
            </dd>
            <dt>{pin.verified_at ? 'Verified at' : 'Expires'}</dt>
            <dd className="text-foreground">
              {formatDateTime(pin.verified_at ?? pin.expires_at)}
            </dd>
            {!pin.verified_at && (
              <>
                <dt>Attempts left</dt>
                <dd className="text-foreground">{pin.attempts_remaining}</dd>
              </>
            )}
          </dl>
        </div>
      )}

      {pin?.active && canVerify && (
        <div className="space-y-2 rounded-lg border p-4">
          <label htmlFor="otp-code" className="text-sm font-medium">
            Enter the customer's 6-digit PIN
          </label>
          <div className="flex gap-2">
            <Input
              id="otp-code"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              placeholder="000000"
              className="max-w-40 font-mono tracking-widest"
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
            />
            <Button
              disabled={code.length !== 6 || verify.isPending}
              onClick={() => verify.mutate()}
            >
              Verify
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            {pin.attempts_remaining} attempt(s) remaining — the PIN is cancelled
            after too many wrong tries.
          </p>
        </div>
      )}

      {canIssue && !pin?.verified_at && (
        <div className="space-y-2 rounded-lg border border-dashed p-4">
          <p className="text-sm font-medium">
            {pin ? 'Send a fresh PIN' : 'Issue a PIN'}
          </p>
          <p className="text-xs text-muted-foreground">
            Leave blank to use the customer's number on file. Issuing a new PIN
            voids the previous one.
          </p>
          <div className="flex gap-2">
            <Input
              placeholder="Send to another number (optional)"
              className="max-w-xs"
              value={sendTo}
              onChange={(e) => setSendTo(e.target.value)}
            />
            <Button
              variant="outline"
              disabled={issue.isPending}
              onClick={() => issue.mutate()}
            >
              {pin ? 'Re-issue' : 'Issue PIN'}
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}
