import { zodResolver } from '@hookform/resolvers/zod'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { useForm } from 'react-hook-form'
import { toast } from 'sonner'
import { z } from 'zod'
import type { PaginatedResponse } from '@triserve/shared'
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
import type { BranchWire } from '@/lib/types'

const branchSchema = z.object({
  code: z
    .string()
    .min(2, 'At least 2 characters')
    .max(20)
    .regex(/^[A-Za-z0-9_-]+$/, 'Letters, digits, "-" and "_" only'),
  name: z.string().min(2, 'At least 2 characters').max(255),
  is_hq: z.boolean(),
  address: z.string().max(500),
  phone: z.string().max(50),
  tz_region: z.string().max(100),
  active: z.boolean(),
})

type BranchForm = z.infer<typeof branchSchema>

const EMPTY: BranchForm = {
  code: '',
  name: '',
  is_hq: false,
  address: '',
  phone: '',
  tz_region: '',
  active: true,
}

/** Branch admin (Task 0.7): list / create / edit — SUPER_ADMIN only. */
export function BranchesPage() {
  const { can } = useAuth()
  const queryClient = useQueryClient()
  const [page, setPage] = useState(1)
  const [q, setQ] = useState('')
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editing, setEditing] = useState<BranchWire | null>(null)

  const canManage = can('config.manage')

  const branches = useQuery({
    queryKey: ['branches', page, q],
    queryFn: async () =>
      (
        await api.get<PaginatedResponse<BranchWire>>('/branches', {
          params: { page, page_size: 20, ...(q ? { q } : {}) },
        })
      ).data,
  })

  const form = useForm<BranchForm>({
    resolver: zodResolver(branchSchema),
    defaultValues: EMPTY,
  })

  function openCreate() {
    setEditing(null)
    form.reset(EMPTY)
    setDialogOpen(true)
  }

  function openEdit(branch: BranchWire) {
    setEditing(branch)
    form.reset({
      code: branch.code,
      name: branch.name,
      is_hq: branch.is_hq,
      address: branch.address ?? '',
      phone: branch.phone ?? '',
      tz_region: branch.tz_region ?? '',
      active: branch.active,
    })
    setDialogOpen(true)
  }

  const save = useMutation({
    mutationFn: async (values: BranchForm) => {
      const payload = {
        code: values.code,
        name: values.name,
        is_hq: values.is_hq,
        address: values.address || undefined,
        phone: values.phone || undefined,
        tz_region: values.tz_region || undefined,
      }
      if (editing) {
        return (
          await api.patch<BranchWire>(`/branches/${editing.id}`, {
            ...payload,
            active: values.active,
          })
        ).data
      }
      return (await api.post<BranchWire>('/branches', payload)).data
    },
    onSuccess: async () => {
      toast.success(editing ? 'Branch updated' : 'Branch created')
      setDialogOpen(false)
      await queryClient.invalidateQueries({ queryKey: ['branches'] })
    },
    onError: (e) => toast.error(apiErrorMessage(e)),
  })

  const submit = form.handleSubmit((values) => save.mutate(values))

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-2">
        <Input
          placeholder="Search code or name…"
          value={q}
          onChange={(e) => {
            setQ(e.target.value)
            setPage(1)
          }}
          className="max-w-xs"
        />
        {canManage && <Button onClick={openCreate}>New branch</Button>}
      </div>

      {branches.isPending && (
        <p className="text-sm text-muted-foreground">Loading…</p>
      )}
      {branches.isError && (
        <p className="text-sm text-destructive">
          {apiErrorMessage(branches.error)}
        </p>
      )}
      {branches.data && (
        <div className="overflow-hidden rounded-xl border bg-card shadow-sm">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Code</TableHead>
                <TableHead>Name</TableHead>
                <TableHead>Region</TableHead>
                <TableHead>Phone</TableHead>
                <TableHead>Status</TableHead>
                {canManage && <TableHead className="w-20" />}
              </TableRow>
            </TableHeader>
            <TableBody>
              {branches.data.data.map((b) => (
                <TableRow key={b.id}>
                  <TableCell className="font-mono">
                    {b.code}
                    {b.is_hq && (
                      <Badge variant="secondary" className="ml-2">
                        HQ
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell>{b.name}</TableCell>
                  <TableCell>{b.tz_region ?? '—'}</TableCell>
                  <TableCell>{b.phone ?? '—'}</TableCell>
                  <TableCell>
                    {b.active ? (
                      <Badge variant="success">Active</Badge>
                    ) : (
                      <Badge variant="secondary">Inactive</Badge>
                    )}
                  </TableCell>
                  {canManage && (
                    <TableCell>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => openEdit(b)}
                      >
                        Edit
                      </Button>
                    </TableCell>
                  )}
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <div className="px-3 pb-3">
            <Pager
              page={branches.data.page}
              pageSize={branches.data.page_size}
              total={branches.data.total}
              onPageChange={setPage}
            />
          </div>
        </div>
      )}

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {editing ? `Edit branch ${editing.code}` : 'New branch'}
            </DialogTitle>
            <DialogDescription>
              Branches are never deleted — deactivate one to retire it.
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-4">
            <div className="grid grid-cols-2 gap-4">
              <FormField
                label="Code"
                htmlFor="branch-code"
                error={form.formState.errors.code?.message}
              >
                <Input id="branch-code" {...form.register('code')} />
              </FormField>
              <FormField
                label="Region"
                htmlFor="branch-region"
                error={form.formState.errors.tz_region?.message}
              >
                <Input
                  id="branch-region"
                  placeholder="e.g. Mwanza"
                  {...form.register('tz_region')}
                />
              </FormField>
            </div>
            <FormField
              label="Name"
              htmlFor="branch-name"
              error={form.formState.errors.name?.message}
            >
              <Input id="branch-name" {...form.register('name')} />
            </FormField>
            <FormField
              label="Address"
              htmlFor="branch-address"
              error={form.formState.errors.address?.message}
            >
              <Input id="branch-address" {...form.register('address')} />
            </FormField>
            <FormField
              label="Phone"
              htmlFor="branch-phone"
              error={form.formState.errors.phone?.message}
            >
              <Input id="branch-phone" {...form.register('phone')} />
            </FormField>
            <div className="flex items-center gap-6 text-sm">
              <label className="flex items-center gap-2">
                <input type="checkbox" {...form.register('is_hq')} />
                Headquarters
              </label>
              {editing && (
                <label className="flex items-center gap-2">
                  <input type="checkbox" {...form.register('active')} />
                  Active
                </label>
              )}
            </div>
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
