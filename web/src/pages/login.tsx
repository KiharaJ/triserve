import { zodResolver } from '@hookform/resolvers/zod'
import { BarChart3, ShieldCheck, Wrench } from 'lucide-react'
import { useState } from 'react'
import { useForm } from 'react-hook-form'
import { Navigate, useLocation, useNavigate } from 'react-router-dom'
import { toast } from 'sonner'
import { z } from 'zod'
import { FormField } from '@/components/shared/form-field'
import { Button } from '@/components/ui/button'
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
    <div className="flex min-h-screen bg-background">
      {/* Brand showcase panel */}
      <div className="relative hidden w-1/2 flex-col justify-between overflow-hidden bg-gradient-to-br from-[#182a9c] via-[#101d78] to-[#0a1250] p-12 text-white lg:flex">
        <div className="pointer-events-none absolute -right-16 -top-16 size-72 rounded-full bg-sky-400/20 blur-3xl" />
        <div className="pointer-events-none absolute -bottom-20 -left-10 size-72 rounded-full bg-blue-500/20 blur-3xl" />
        <div className="relative flex items-center gap-3">
          <span className="flex size-11 items-center justify-center rounded-xl bg-white text-[#101d78] shadow-lg ring-1 ring-white/40">
            <Wrench className="size-6" />
          </span>
          <div className="flex flex-col leading-none">
            <span className="text-2xl font-bold tracking-tight">TriServe</span>
            <span className="text-[11px] font-semibold uppercase tracking-[0.16em] text-sky-200/80">
              Service Centre
            </span>
          </div>
        </div>
        <div className="relative flex flex-col gap-6">
          <h2 className="max-w-md text-3xl font-bold leading-tight">
            Run your whole repair operation from one place.
          </h2>
          <ul className="flex flex-col gap-4 text-sm text-sky-100/90">
            <li className="flex items-center gap-3">
              <span className="flex size-9 items-center justify-center rounded-lg bg-white/10 ring-1 ring-white/15">
                <Wrench className="size-4 text-sky-300" />
              </span>
              Jobs, POS &amp; inventory across every branch
            </li>
            <li className="flex items-center gap-3">
              <span className="flex size-9 items-center justify-center rounded-lg bg-white/10 ring-1 ring-white/15">
                <BarChart3 className="size-4 text-sky-300" />
              </span>
              Live dashboards, warranty claims &amp; a real ledger
            </li>
            <li className="flex items-center gap-3">
              <span className="flex size-9 items-center justify-center rounded-lg bg-white/10 ring-1 ring-white/15">
                <ShieldCheck className="size-4 text-sky-300" />
              </span>
              Role-based access with full audit trail
            </li>
          </ul>
        </div>
        <p className="relative text-xs text-sky-200/60">
          Samsung Authorized Service Centre
        </p>
      </div>

      {/* Form panel */}
      <div className="flex w-full flex-col items-center justify-center p-6 lg:w-1/2">
        <div className="w-full max-w-sm">
          <div className="mb-8 flex items-center gap-3 lg:hidden">
            <span className="flex size-10 items-center justify-center rounded-xl bg-primary text-primary-foreground shadow-md">
              <Wrench className="size-5" />
            </span>
            <span className="text-xl font-bold tracking-tight">TriServe</span>
          </div>
          <h1 className="text-2xl font-bold tracking-tight">
            {mfaToken ? 'Two-factor verification' : 'Welcome back'}
          </h1>
          <p className="mb-6 mt-1 text-sm text-muted-foreground">
            {mfaToken
              ? 'Enter the 6-digit code from your authenticator app'
              : 'Sign in to your service centre'}
          </p>
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
        </div>
      </div>
    </div>
  )
}
