import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { toast } from 'sonner'
import type { PaginatedResponse } from '@triserve/shared'
import { FormField } from '@/components/shared/form-field'
import { Pager } from '@/components/shared/pager'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
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
import { useAuth } from '@/lib/auth'
import { formatDateTime } from '@/lib/format'
import type { SessionEntry } from '@/lib/types'

interface TotpSetup {
  otpauth_url: string
  qr_data_uri: string
}

/**
 * Security (Task 0.7): TOTP 2FA setup (QR → confirm code) / disable, and
 * the account's session / device login history from GET /auth/sessions.
 */
export function SecurityPage() {
  const { user, refreshUser } = useAuth()
  const queryClient = useQueryClient()
  const [setup, setSetup] = useState<TotpSetup | null>(null)
  const [confirmCode, setConfirmCode] = useState('')
  const [disableCode, setDisableCode] = useState('')
  const [page, setPage] = useState(1)

  const sessions = useQuery({
    queryKey: ['sessions', page],
    queryFn: async () =>
      (
        await api.get<PaginatedResponse<SessionEntry>>('/auth/sessions', {
          params: { page, page_size: 10 },
        })
      ).data,
  })

  const startSetup = useMutation({
    mutationFn: async () =>
      (await api.post<TotpSetup>('/auth/2fa/setup')).data,
    onSuccess: (data) => setSetup(data),
    onError: (e) => toast.error(apiErrorMessage(e)),
  })

  const confirm = useMutation({
    mutationFn: async (code: string) =>
      (await api.post('/auth/2fa/confirm', { code })).data,
    onSuccess: async () => {
      toast.success('Two-factor authentication enabled')
      setSetup(null)
      setConfirmCode('')
      await refreshUser()
    },
    onError: (e) => toast.error(apiErrorMessage(e)),
  })

  const disable = useMutation({
    mutationFn: async (code: string) =>
      (await api.post('/auth/2fa/disable', { code })).data,
    onSuccess: async () => {
      toast.success('Two-factor authentication disabled')
      setDisableCode('')
      await refreshUser()
      await queryClient.invalidateQueries({ queryKey: ['sessions'] })
    },
    onError: (e) => toast.error(apiErrorMessage(e)),
  })

  return (
    <div className="flex max-w-3xl flex-col gap-6">
      <Card>
        <CardHeader>
          <CardTitle>Two-factor authentication</CardTitle>
          <CardDescription>
            Protect your account with a 6-digit code from an authenticator
            app (TOTP).
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="flex items-center gap-2 text-sm">
            Status:
            {user?.totp_enabled ? (
              <Badge variant="success">Enabled</Badge>
            ) : (
              <Badge variant="secondary">Disabled</Badge>
            )}
          </div>

          {!user?.totp_enabled && setup === null && (
            <Button
              className="w-fit"
              onClick={() => startSetup.mutate()}
              disabled={startSetup.isPending}
            >
              {startSetup.isPending ? 'Preparing…' : 'Enable 2FA'}
            </Button>
          )}

          {!user?.totp_enabled && setup !== null && (
            <div className="flex flex-col gap-4 sm:flex-row sm:items-start">
              <img
                src={setup.qr_data_uri}
                alt="TOTP QR code"
                className="size-40 rounded-lg border bg-white p-2"
              />
              <div className="flex flex-1 flex-col gap-3">
                <p className="text-sm text-muted-foreground">
                  Scan the QR code with Google Authenticator, 1Password or a
                  similar app, then enter the current 6-digit code to
                  confirm.
                </p>
                <FormField label="Confirmation code" htmlFor="confirm-code">
                  <Input
                    id="confirm-code"
                    inputMode="numeric"
                    maxLength={6}
                    placeholder="000000"
                    value={confirmCode}
                    onChange={(e) => setConfirmCode(e.target.value)}
                    className="max-w-40 font-mono"
                  />
                </FormField>
                <div className="flex gap-2">
                  <Button
                    onClick={() => confirm.mutate(confirmCode)}
                    disabled={
                      confirm.isPending || !/^\d{6}$/.test(confirmCode)
                    }
                  >
                    {confirm.isPending ? 'Confirming…' : 'Confirm & enable'}
                  </Button>
                  <Button variant="ghost" onClick={() => setSetup(null)}>
                    Cancel
                  </Button>
                </div>
              </div>
            </div>
          )}

          {user?.totp_enabled && (
            <div className="flex flex-col gap-3">
              <FormField
                label="Enter a current code to disable 2FA"
                htmlFor="disable-code"
              >
                <Input
                  id="disable-code"
                  inputMode="numeric"
                  maxLength={6}
                  placeholder="000000"
                  value={disableCode}
                  onChange={(e) => setDisableCode(e.target.value)}
                  className="max-w-40 font-mono"
                />
              </FormField>
              <Button
                variant="destructive"
                className="w-fit"
                onClick={() => disable.mutate(disableCode)}
                disabled={disable.isPending || !/^\d{6}$/.test(disableCode)}
              >
                {disable.isPending ? 'Disabling…' : 'Disable 2FA'}
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Login history</CardTitle>
          <CardDescription>
            Your sessions and devices. Times are shown in Africa/Dar es
            Salaam.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {sessions.isPending && (
            <p className="text-sm text-muted-foreground">Loading…</p>
          )}
          {sessions.isError && (
            <p className="text-sm text-destructive">
              {apiErrorMessage(sessions.error)}
            </p>
          )}
          {sessions.data && (
            <>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Signed in</TableHead>
                    <TableHead>Last active</TableHead>
                    <TableHead>IP</TableHead>
                    <TableHead>Device</TableHead>
                    <TableHead>Status</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {sessions.data.data.map((s) => (
                    <TableRow key={s.id}>
                      <TableCell>{formatDateTime(s.created_at)}</TableCell>
                      <TableCell>{formatDateTime(s.last_used_at)}</TableCell>
                      <TableCell>{s.ip ?? '—'}</TableCell>
                      <TableCell
                        className="max-w-64 truncate whitespace-normal text-xs text-muted-foreground"
                        title={s.user_agent ?? undefined}
                      >
                        {s.user_agent ?? '—'}
                      </TableCell>
                      <TableCell>
                        {s.current ? (
                          <Badge variant="success">This device</Badge>
                        ) : s.revoked_at ? (
                          <Badge variant="secondary">Signed out</Badge>
                        ) : (
                          <Badge variant="outline">Active</Badge>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              <Pager
                page={sessions.data.page}
                pageSize={sessions.data.page_size}
                total={sessions.data.total}
                onPageChange={setPage}
              />
            </>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
