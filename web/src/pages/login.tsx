import { zodResolver } from '@hookform/resolvers/zod'
import { useState } from 'react'
import { useForm } from 'react-hook-form'
import { Navigate, useLocation, useNavigate } from 'react-router-dom'
import { toast } from 'sonner'
import { z } from 'zod'
import { FormField } from '@/components/shared/form-field'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { apiErrorMessage } from '@/lib/api'
import { useAuth } from '@/lib/auth'

const credentialsSchema = z.object({
  email: z.string().email('Enter a valid email address'),
  password: z.string().min(1, 'Enter your password'),
})

const codeSchema = z.object({
  code: z
    .string()
    .regex(/^\d{6}$/, 'Enter the 6-digit code from your authenticator app'),
})

type Credentials = z.infer<typeof credentialsSchema>
type Code = z.infer<typeof codeSchema>

/**
 * Login (Task 0.7): email/password, then — when the account has TOTP
 * enabled — a second 6-digit code step against POST /auth/login/verify.
 */
export function LoginPage() {
  const { status, login, verifyMfa } = useAuth()
  const navigate = useNavigate()
  const location = useLocation()
  const [mfaToken, setMfaToken] = useState<string | null>(null)

  const from =
    (location.state as { from?: string } | null)?.from ?? '/'

  const credForm = useForm<Credentials>({
    resolver: zodResolver(credentialsSchema),
    defaultValues: { email: '', password: '' },
  })
  const codeForm = useForm<Code>({
    resolver: zodResolver(codeSchema),
    defaultValues: { code: '' },
  })

  if (status === 'authenticated') {
    return <Navigate to={from} replace />
  }

  const submitCredentials = credForm.handleSubmit(async (values) => {
    try {
      const result = await login(values.email, values.password)
      if (result.kind === 'mfa_required') {
        setMfaToken(result.mfa_token)
        return
      }
      toast.success('Signed in')
      navigate(from, { replace: true })
    } catch (e) {
      toast.error(apiErrorMessage(e))
    }
  })

  const submitCode = codeForm.handleSubmit(async (values) => {
    if (!mfaToken) return
    try {
      await verifyMfa(mfaToken, values.code)
      toast.success('Signed in')
      navigate(from, { replace: true })
    } catch (e) {
      toast.error(apiErrorMessage(e))
    }
  })

  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle className="text-lg">TriServe</CardTitle>
          <CardDescription>
            {mfaToken
              ? 'Enter the 6-digit code from your authenticator app'
              : 'Sign in to your service centre'}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {mfaToken === null ? (
            <form onSubmit={(e) => void submitCredentials(e)} className="flex flex-col gap-4">
              <FormField
                label="Email"
                htmlFor="email"
                error={credForm.formState.errors.email?.message}
              >
                <Input
                  id="email"
                  type="email"
                  autoComplete="email"
                  autoFocus
                  {...credForm.register('email')}
                />
              </FormField>
              <FormField
                label="Password"
                htmlFor="password"
                error={credForm.formState.errors.password?.message}
              >
                <Input
                  id="password"
                  type="password"
                  autoComplete="current-password"
                  {...credForm.register('password')}
                />
              </FormField>
              <Button type="submit" disabled={credForm.formState.isSubmitting}>
                {credForm.formState.isSubmitting ? 'Signing in…' : 'Sign in'}
              </Button>
            </form>
          ) : (
            <form onSubmit={(e) => void submitCode(e)} className="flex flex-col gap-4">
              <FormField
                label="Verification code"
                htmlFor="code"
                error={codeForm.formState.errors.code?.message}
              >
                <Input
                  id="code"
                  inputMode="numeric"
                  maxLength={6}
                  placeholder="000000"
                  autoFocus
                  className="text-center font-mono text-lg tracking-[0.4em]"
                  {...codeForm.register('code')}
                />
              </FormField>
              <Button type="submit" disabled={codeForm.formState.isSubmitting}>
                {codeForm.formState.isSubmitting ? 'Verifying…' : 'Verify'}
              </Button>
              <Button
                type="button"
                variant="ghost"
                onClick={() => {
                  setMfaToken(null)
                  codeForm.reset()
                }}
              >
                Back to password
              </Button>
            </form>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
