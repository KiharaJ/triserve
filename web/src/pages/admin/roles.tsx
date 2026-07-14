import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import {
  PERMISSION_DOMAIN_LABELS,
  PERMISSION_LABELS,
  PERMISSIONS,
  type Permission,
  type RoleMatrixEntry,
  type RoleName,
  type RolesMatrixResponse,
} from '@triserve/shared'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { api, apiErrorMessage } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { cn } from '@/lib/utils'

const DOMAINS = Object.entries(PERMISSIONS) as [
  keyof typeof PERMISSIONS,
  readonly Permission[],
][]

/**
 * Roles & permissions (E17): view and edit each role's effective permission
 * set for this company. Edits persist as a delta from the built-in defaults;
 * SUPER_ADMIN is immutable. UI is gated by user.read (view) / user.manage
 * (edit); the API re-checks every write.
 */
export function RolesPage() {
  const { can, refreshUser, user: me } = useAuth()
  const queryClient = useQueryClient()
  const canManage = can('user.manage')

  const roles = useQuery({
    queryKey: ['roles'],
    queryFn: async () =>
      (await api.get<RolesMatrixResponse>('/roles')).data.roles,
  })

  const [selected, setSelected] = useState<RoleName | null>(null)
  const [draft, setDraft] = useState<Set<Permission>>(new Set())

  const entry = useMemo<RoleMatrixEntry | undefined>(
    () => roles.data?.find((r) => r.role === selected),
    [roles.data, selected],
  )

  // Default the selection to the first editable role once data arrives.
  useEffect(() => {
    if (!roles.data || selected) return
    const first = roles.data.find((r) => r.editable) ?? roles.data[0]
    if (first) setSelected(first.role)
  }, [roles.data, selected])

  // (Re)seed the working draft whenever the selected role's server state loads.
  useEffect(() => {
    if (entry) setDraft(new Set(entry.effective))
  }, [entry])

  const save = useMutation({
    mutationFn: async (role: RoleName) =>
      (
        await api.put<RoleMatrixEntry>(`/roles/${role}/permissions`, {
          permissions: [...draft],
        })
      ).data,
    onSuccess: async (updated) => {
      toast.success(`${updated.label} permissions saved`)
      setDraft(new Set(updated.effective))
      await queryClient.invalidateQueries({ queryKey: ['roles'] })
      // If we edited our OWN role, refresh /me so the UI regates immediately.
      if (me?.role === updated.role) await refreshUser()
    },
    onError: (e) => toast.error(apiErrorMessage(e)),
  })

  const reset = useMutation({
    mutationFn: async (role: RoleName) =>
      (await api.post<RoleMatrixEntry>(`/roles/${role}/reset`)).data,
    onSuccess: async (updated) => {
      toast.success(`${updated.label} reset to defaults`)
      setDraft(new Set(updated.effective))
      await queryClient.invalidateQueries({ queryKey: ['roles'] })
      if (me?.role === updated.role) await refreshUser()
    },
    onError: (e) => toast.error(apiErrorMessage(e)),
  })

  const defaultSet = useMemo(
    () => new Set(entry?.default ?? []),
    [entry],
  )
  const dirty = useMemo(() => {
    if (!entry) return false
    const eff = new Set(entry.effective)
    if (eff.size !== draft.size) return true
    for (const p of draft) if (!eff.has(p)) return true
    return false
  }, [entry, draft])

  const editable = (entry?.editable ?? false) && canManage
  const busy = save.isPending || reset.isPending

  function toggle(perm: Permission) {
    setDraft((prev) => {
      const next = new Set(prev)
      if (next.has(perm)) next.delete(perm)
      else next.add(perm)
      return next
    })
  }

  function toggleDomain(perms: readonly Permission[], on: boolean) {
    setDraft((prev) => {
      const next = new Set(prev)
      for (const p of perms) {
        if (on) next.add(p)
        else next.delete(p)
      }
      return next
    })
  }

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-lg font-semibold">Roles &amp; permissions</h1>
        <p className="text-sm text-muted-foreground">
          Tune what each role can do. Changes apply to everyone with that role
          in your company and take effect immediately.
        </p>
      </div>

      {roles.isPending && (
        <p className="text-sm text-muted-foreground">Loading…</p>
      )}
      {roles.isError && (
        <p className="text-sm text-destructive">{apiErrorMessage(roles.error)}</p>
      )}

      {roles.data && (
        <div className="grid gap-4 lg:grid-cols-[18rem_1fr]">
          {/* Role list */}
          <div className="flex flex-col gap-2">
            {roles.data.map((r) => {
              const active = r.role === selected
              return (
                <button
                  key={r.role}
                  type="button"
                  onClick={() => setSelected(r.role)}
                  className={cn(
                    'rounded-xl border bg-card p-3 text-left shadow-sm transition-colors',
                    active
                      ? 'border-primary ring-1 ring-primary'
                      : 'hover:border-muted-foreground/30',
                  )}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-medium">{r.label}</span>
                    <Badge variant="secondary">
                      {r.user_count} {r.user_count === 1 ? 'user' : 'users'}
                    </Badge>
                  </div>
                  <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">
                    {r.description}
                  </p>
                  <div className="mt-2 flex flex-wrap gap-1">
                    {!r.editable && <Badge variant="info">Locked</Badge>}
                    {r.overridden.length > 0 && (
                      <Badge variant="warning">
                        {r.overridden.length} customised
                      </Badge>
                    )}
                  </div>
                </button>
              )
            })}
          </div>

          {/* Permission editor */}
          {entry && (
            <Card>
              <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div>
                  <CardTitle>{entry.label}</CardTitle>
                  <CardDescription>{entry.description}</CardDescription>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {draft.size} of {ALL_COUNT} permissions granted
                  </p>
                </div>
                {editable && (
                  <div className="flex shrink-0 gap-2">
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={busy || entry.overridden.length === 0}
                      onClick={() => reset.mutate(entry.role)}
                    >
                      Reset to defaults
                    </Button>
                    <Button
                      size="sm"
                      disabled={busy || !dirty}
                      onClick={() => save.mutate(entry.role)}
                    >
                      {save.isPending ? 'Saving…' : 'Save changes'}
                    </Button>
                  </div>
                )}
              </CardHeader>
              <CardContent className="flex flex-col gap-5">
                {!entry.editable && (
                  <p className="rounded-lg bg-muted/60 px-3 py-2 text-xs text-muted-foreground">
                    {entry.label} always holds every permission and cannot be
                    edited.
                  </p>
                )}
                {entry.editable && !canManage && (
                  <p className="rounded-lg bg-muted/60 px-3 py-2 text-xs text-muted-foreground">
                    You have read-only access. Managing roles requires the
                    “Manage users &amp; roles” permission.
                  </p>
                )}

                {DOMAINS.map(([domain, perms]) => {
                  const allOn = perms.every((p) => draft.has(p))
                  return (
                    <section key={domain} className="flex flex-col gap-2">
                      <div className="flex items-center justify-between">
                        <h3 className="text-sm font-semibold">
                          {PERMISSION_DOMAIN_LABELS[domain]}
                        </h3>
                        {editable && (
                          <button
                            type="button"
                            className="text-xs text-muted-foreground hover:text-foreground"
                            onClick={() => toggleDomain(perms, !allOn)}
                          >
                            {allOn ? 'Clear all' : 'Select all'}
                          </button>
                        )}
                      </div>
                      <div className="grid gap-1.5 sm:grid-cols-2">
                        {perms.map((perm) => {
                          const on = draft.has(perm)
                          const changed = on !== defaultSet.has(perm)
                          return (
                            <label
                              key={perm}
                              className={cn(
                                'flex items-center gap-2 rounded-lg border px-3 py-2 text-sm',
                                editable
                                  ? 'cursor-pointer hover:bg-muted/50'
                                  : 'opacity-90',
                                changed && 'border-amber-500/40 bg-amber-500/5',
                              )}
                            >
                              <input
                                type="checkbox"
                                className="h-4 w-4 accent-primary"
                                checked={on}
                                disabled={!editable}
                                onChange={() => toggle(perm)}
                              />
                              <span className="flex-1">
                                {PERMISSION_LABELS[perm]}
                              </span>
                              <code className="text-[10px] text-muted-foreground">
                                {perm}
                              </code>
                              {changed && (
                                <span
                                  className="h-1.5 w-1.5 rounded-full bg-amber-500"
                                  title="Changed from default"
                                />
                              )}
                            </label>
                          )
                        })}
                      </div>
                    </section>
                  )
                })}
              </CardContent>
            </Card>
          )}
        </div>
      )}
    </div>
  )
}

const ALL_COUNT = DOMAINS.reduce((n, [, perms]) => n + perms.length, 0)
