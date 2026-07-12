import { zodResolver } from '@hookform/resolvers/zod'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { useForm } from 'react-hook-form'
import { toast } from 'sonner'
import { z } from 'zod'
import { USER_ROLES, type PaginatedResponse } from '@triserve/shared'
import { FormField } from '@/components/shared/form-field'
import { Pager } from '@/components/shared/pager'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
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
import type { BranchWire, UserWire } from '@/lib/types'

const userSchema = z
  .object({
    full_name: z.string().min(2, 'At least 2 characters').max(255),
    email: z.string().email('Enter a valid email'),
    phone: z.string().max(50),
    password: z
      .string()
      .refine((v) => v === '' || v.length >= 8, {
        message: 'At least 8 characters',
      }),
    role: z.enum(USER_ROLES),
    scope: z.enum(['branch', 'group']),
    home_branch_id: z.string(),
  })
  .refine((v) => v.scope !== 'branch' || v.home_branch_id !== '', {
    message: 'Branch-scoped users need a home branch',
    path: ['home_branch_id'],
  })

type UserForm = z.infer<typeof userSchema>

const EMPTY: UserForm = {
  full_name: '',
  email: '',
  phone: '',
  password: '',
  role: 'TECHNICIAN',
  scope: 'branch',
  home_branch_id: '',
}

/**
 * User admin (Task 0.7): list + filter by branch/role, create/edit with
 * role + scope + home branch, activate/deactivate. Password hashes never
 * reach this page — the API only ships sanitized wire users.
 */
export function UsersPage() {
  const { user: me, can } = useAuth()
  const queryClient = useQueryClient()
  const [page, setPage] = useState(1)
  const [q, setQ] = useState('')
  const [roleFilter, setRoleFilter] = useState('')
  const [branchFilter, setBranchFilter] = useState('')
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editing, setEditing] = useState<UserWire | null>(null)

  const canManage = can('user.manage')

  const branches = useQuery({
    queryKey: ['branches', 'all'],
    queryFn: async () =>
      (
        await api.get<PaginatedResponse<BranchWire>>('/branches', {
          params: { page_size: 100 },
        })
      ).data.data,
  })

  const users = useQuery({
    queryKey: ['users', page, q, roleFilter, branchFilter],
    queryFn: async () =>
      (
        await api.get<PaginatedResponse<UserWire>>('/users', {
          params: {
            page,
            page_size: 20,
            ...(q ? { q } : {}),
            ...(roleFilter ? { role: roleFilter } : {}),
            ...(branchFilter ? { branch_id: branchFilter } : {}),
          },
        })
      ).data,
  })

  const form = useForm<UserForm>({
    resolver: zodResolver(userSchema),
    defaultValues: EMPTY,
  })
  const scope = form.watch('scope')

  function openCreate() {
    setEditing(null)
    form.reset(EMPTY)
    setDialogOpen(true)
  }

  function openEdit(u: UserWire) {
    setEditing(u)
    form.reset({
      full_name: u.full_name,
      email: u.email,
      phone: u.phone ?? '',
      password: '',
      role: u.role,
      scope: u.scope,
      home_branch_id: u.home_branch_id ?? '',
    })
    setDialogOpen(true)
  }

  const save = useMutation({
    mutationFn: async (values: UserForm) => {
      const common = {
        full_name: values.full_name,
        email: values.email,
        phone: values.phone || undefined,
        role: values.role,
        scope: values.scope,
        home_branch_id:
          values.home_branch_id === '' ? null : values.home_branch_id,
      }
      if (editing) {
        return (
          await api.patch<UserWire>(`/users/${editing.id}`, {
            ...common,
            ...(values.password ? { password: values.password } : {}),
          })
        ).data
      }
      if (!values.password) {
        throw new Error('missing password')
      }
      return (
        await api.post<UserWire>('/users', {
          ...common,
          home_branch_id: common.home_branch_id ?? undefined,
          password: values.password,
        })
      ).data
    },
    onSuccess: async () => {
      toast.success(editing ? 'User updated' : 'User created')
      setDialogOpen(false)
      await queryClient.invalidateQueries({ queryKey: ['users'] })
    },
    onError: (e) => {
      if (e instanceof Error && e.message === 'missing password') {
        form.setError('password', {
          message: 'An initial password is required',
        })
        return
      }
      toast.error(apiErrorMessage(e))
    },
  })

  const setActive = useMutation({
    mutationFn: async ({ id, active }: { id: string; active: boolean }) =>
      (
        await api.post<UserWire>(
          `/users/${id}/${active ? 'activate' : 'deactivate'}`,
        )
      ).data,
    onSuccess: async (u) => {
      toast.success(u.active ? 'User activated' : 'User deactivated')
      await queryClient.invalidateQueries({ queryKey: ['users'] })
    },
    onError: (e) => toast.error(apiErrorMessage(e)),
  })

  const submit = form.handleSubmit((values) => save.mutate(values))

  const branchName = (id: string | null) =>
    branches.data?.find((b) => b.id === id)?.code ?? (id ? '…' : '—')

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <Input
          placeholder="Search name or email…"
          value={q}
          onChange={(e) => {
            setQ(e.target.value)
            setPage(1)
          }}
          className="max-w-xs"
        />
        <Select
          value={roleFilter}
          onChange={(e) => {
            setRoleFilter(e.target.value)
            setPage(1)
          }}
          className="w-44"
          aria-label="Filter by role"
        >
          <option value="">All roles</option>
          {USER_ROLES.map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </Select>
        <Select
          value={branchFilter}
          onChange={(e) => {
            setBranchFilter(e.target.value)
            setPage(1)
          }}
          className="w-44"
          aria-label="Filter by branch"
        >
          <option value="">All branches</option>
          {branches.data?.map((b) => (
            <option key={b.id} value={b.id}>
              {b.code} — {b.name}
            </option>
          ))}
        </Select>
        <div className="flex-1" />
        {canManage && <Button onClick={openCreate}>New user</Button>}
      </div>

      {users.isPending && (
        <p className="text-sm text-muted-foreground">Loading…</p>
      )}
      {users.isError && (
        <p className="text-sm text-destructive">
          {apiErrorMessage(users.error)}
        </p>
      )}
      {users.data && (
        <div className="overflow-hidden rounded-xl border bg-card shadow-sm">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Email</TableHead>
                <TableHead>Role</TableHead>
                <TableHead>Scope</TableHead>
                <TableHead>Branch</TableHead>
                <TableHead>2FA</TableHead>
                <TableHead>Status</TableHead>
                {canManage && <TableHead className="w-40" />}
              </TableRow>
            </TableHeader>
            <TableBody>
              {users.data.data.map((u) => (
                <TableRow key={u.id}>
                  <TableCell>{u.full_name}</TableCell>
                  <TableCell className="text-muted-foreground">
                    {u.email}
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline">{u.role}</Badge>
                  </TableCell>
                  <TableCell>{u.scope}</TableCell>
                  <TableCell className="font-mono">
                    {branchName(u.home_branch_id)}
                  </TableCell>
                  <TableCell>
                    {u.totp_enabled ? (
                      <Badge variant="success">On</Badge>
                    ) : (
                      <Badge variant="secondary">Off</Badge>
                    )}
                  </TableCell>
                  <TableCell>
                    {u.active ? (
                      <Badge variant="success">Active</Badge>
                    ) : (
                      <Badge variant="destructive">Inactive</Badge>
                    )}
                  </TableCell>
                  {canManage && (
                    <TableCell>
                      <div className="flex gap-1">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => openEdit(u)}
                        >
                          Edit
                        </Button>
                        {u.id !== me?.id && (
                          <Button
                            variant={u.active ? 'destructive' : 'outline'}
                            size="sm"
                            disabled={setActive.isPending}
                            onClick={() =>
                              setActive.mutate({
                                id: u.id,
                                active: !u.active,
                              })
                            }
                          >
                            {u.active ? 'Deactivate' : 'Activate'}
                          </Button>
                        )}
                      </div>
                    </TableCell>
                  )}
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <div className="px-3 pb-3">
            <Pager
              page={users.data.page}
              pageSize={users.data.page_size}
              total={users.data.total}
              onPageChange={setPage}
            />
          </div>
        </div>
      )}

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {editing ? `Edit ${editing.full_name}` : 'New user'}
            </DialogTitle>
            <DialogDescription>
              {editing
                ? 'Leave the password blank to keep the current one.'
                : 'The user signs in with this email and initial password.'}
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <FormField
                label="Full name"
                htmlFor="user-name"
                error={form.formState.errors.full_name?.message}
              >
                <Input id="user-name" {...form.register('full_name')} />
              </FormField>
              <FormField
                label="Email"
                htmlFor="user-email"
                error={form.formState.errors.email?.message}
              >
                <Input
                  id="user-email"
                  type="email"
                  {...form.register('email')}
                />
              </FormField>
              <FormField
                label="Phone"
                htmlFor="user-phone"
                error={form.formState.errors.phone?.message}
              >
                <Input id="user-phone" {...form.register('phone')} />
              </FormField>
              <FormField
                label={editing ? 'New password (optional)' : 'Initial password'}
                htmlFor="user-password"
                error={form.formState.errors.password?.message}
              >
                <Input
                  id="user-password"
                  type="password"
                  autoComplete="new-password"
                  {...form.register('password')}
                />
              </FormField>
              <FormField
                label="Role"
                htmlFor="user-role"
                error={form.formState.errors.role?.message}
              >
                <Select id="user-role" {...form.register('role')}>
                  {USER_ROLES.map((r) => (
                    <option key={r} value={r}>
                      {r}
                    </option>
                  ))}
                </Select>
              </FormField>
              <FormField
                label="Scope"
                htmlFor="user-scope"
                error={form.formState.errors.scope?.message}
                hint="Group-scoped users can act across all branches"
              >
                <Select id="user-scope" {...form.register('scope')}>
                  <option value="branch">branch</option>
                  <option value="group">group</option>
                </Select>
              </FormField>
            </div>
            <FormField
              label={scope === 'branch' ? 'Home branch' : 'Home branch (optional)'}
              htmlFor="user-branch"
              error={form.formState.errors.home_branch_id?.message}
            >
              <Select id="user-branch" {...form.register('home_branch_id')}>
                <option value="">— none —</option>
                {branches.data?.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.code} — {b.name}
                  </option>
                ))}
              </Select>
            </FormField>
            <DialogFooter>
              <Button
                type="button"
                variant="ghost"
                onClick={() => setDialogOpen(false)}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={save.isPending}>
                {save.isPending ? 'Saving…' : 'Save'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  )
}
