import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { toast } from 'sonner'
import type { PaginatedResponse } from '@triserve/shared'
import { FormField } from '@/components/shared/form-field'
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
import { formatDate } from '@/lib/format'
import type { DeviceCategory, UserSkill, UserWire } from '@/lib/types'

const CATEGORIES: DeviceCategory[] = ['HHP', 'CE', 'AC', 'REF', 'OTHER']

/** 1 = trainee … 5 = master, per the proposal's skill matrix. */
const LEVELS = [1, 2, 3, 4, 5]

const LEVEL_LABEL: Record<number, string> = {
  1: 'Trainee',
  2: 'Assisted',
  3: 'Competent',
  4: 'Senior',
  5: 'Master',
}

/**
 * Skill matrix (SCMS proposal Module 2, §3) — which technician is certified
 * for which device class, and who may sign QC off.
 *
 * This drives two live gates: the `engineer_skill_match` guard refuses to let
 * a job start on the bench of someone uncertified for the device, and QC
 * approval is limited to holders of `can_qc` for that class. An EMPTY matrix
 * is treated as "not configured" rather than "nobody is allowed" — a shop
 * that has not filled this in keeps working.
 */
export function SkillsPage() {
  const { can } = useAuth()
  const queryClient = useQueryClient()
  const [categoryFilter, setCategoryFilter] = useState('')
  const [editing, setEditing] = useState<UserSkill | null>(null)
  const [adding, setAdding] = useState(false)

  const canManage = can('user.manage')

  const skills = useQuery({
    queryKey: ['skills', categoryFilter],
    queryFn: async () =>
      (
        await api.get<PaginatedResponse<UserSkill>>('/skills', {
          params: {
            page_size: 200,
            ...(categoryFilter ? { category: categoryFilter } : {}),
          },
        })
      ).data.data,
  })

  const users = useQuery({
    queryKey: ['users', 'all'],
    enabled: canManage,
    queryFn: async () =>
      (
        await api.get<PaginatedResponse<UserWire>>('/users', {
          params: { page_size: 200, active: true },
        })
      ).data.data,
  })

  const remove = useMutation({
    mutationFn: async (id: string) => api.delete(`/skills/${id}`),
    onSuccess: async () => {
      toast.success('Skill removed')
      await queryClient.invalidateQueries({ queryKey: ['skills'] })
    },
    onError: (e) => toast.error(apiErrorMessage(e)),
  })

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <Select
          value={categoryFilter}
          onChange={(e) => setCategoryFilter(e.target.value)}
          className="w-40"
          aria-label="Filter by device class"
        >
          <option value="">All device classes</option>
          {CATEGORIES.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </Select>
        <div className="flex-1" />
        {canManage && (
          <Button onClick={() => setAdding(true)}>Certify a technician</Button>
        )}
      </div>

      {skills.isPending && (
        <p className="text-sm text-muted-foreground">Loading…</p>
      )}
      {skills.isError && (
        <p className="text-sm text-destructive">
          {apiErrorMessage(skills.error)}
        </p>
      )}

      {skills.data && (
        <div className="overflow-hidden rounded-xl border bg-card shadow-sm">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Technician</TableHead>
                <TableHead>Role</TableHead>
                <TableHead>Device class</TableHead>
                <TableHead>Level</TableHead>
                <TableHead>QC sign-off</TableHead>
                <TableHead>Certified</TableHead>
                {canManage && <TableHead className="w-32" />}
              </TableRow>
            </TableHeader>
            <TableBody>
              {skills.data.length === 0 && (
                <TableRow>
                  <TableCell
                    colSpan={canManage ? 7 : 6}
                    className="text-center text-muted-foreground"
                  >
                    The matrix is empty — no skill gate is being applied yet.
                  </TableCell>
                </TableRow>
              )}
              {skills.data.map((s) => (
                <TableRow key={s.id}>
                  <TableCell className="font-medium">{s.user_name}</TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {s.user_role}
                  </TableCell>
                  <TableCell>{s.category}</TableCell>
                  <TableCell>
                    {LEVEL_LABEL[s.level] ?? s.level}
                    <span className="ml-1 text-xs text-muted-foreground">
                      ({s.level}/5)
                    </span>
                  </TableCell>
                  <TableCell>
                    {s.can_qc ? (
                      <Badge variant="success">Can approve QC</Badge>
                    ) : (
                      <span className="text-sm text-muted-foreground">—</span>
                    )}
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {s.certified_at ? formatDate(s.certified_at) : '—'}
                  </TableCell>
                  {canManage && (
                    <TableCell>
                      <Button
                        variant="ghost"
                        size="xs"
                        onClick={() => setEditing(s)}
                      >
                        Edit
                      </Button>
                      <Button
                        variant="ghost"
                        size="xs"
                        disabled={remove.isPending}
                        onClick={() => remove.mutate(s.id)}
                      >
                        Remove
                      </Button>
                    </TableCell>
                  )}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      {(adding || editing) && (
        <SkillDialog
          skill={editing}
          users={users.data ?? []}
          onClose={() => {
            setAdding(false)
            setEditing(null)
          }}
          onSaved={async () => {
            setAdding(false)
            setEditing(null)
            await queryClient.invalidateQueries({ queryKey: ['skills'] })
          }}
        />
      )}
    </div>
  )
}

function SkillDialog({
  skill,
  users,
  onClose,
  onSaved,
}: {
  skill: UserSkill | null
  users: UserWire[]
  onClose: () => void
  onSaved: () => void | Promise<void>
}) {
  const [userId, setUserId] = useState(skill?.user_id ?? '')
  const [category, setCategory] = useState<DeviceCategory>(
    skill?.category ?? 'HHP',
  )
  const [level, setLevel] = useState(skill?.level ?? 3)
  const [canQc, setCanQc] = useState(skill?.can_qc ?? false)
  const [certifiedAt, setCertifiedAt] = useState(
    skill?.certified_at?.slice(0, 10) ?? '',
  )

  // PUT /skills upserts on (user, category, service line), so the same call
  // creates and edits — there is no separate PATCH.
  const save = useMutation({
    mutationFn: async () =>
      api.put('/skills', {
        user_id: userId,
        category,
        level,
        can_qc: canQc,
        ...(certifiedAt ? { certified_at: `${certifiedAt}T00:00:00.000Z` } : {}),
      }),
    onSuccess: async () => {
      toast.success('Skill matrix updated')
      await onSaved()
    },
    onError: (e) => toast.error(apiErrorMessage(e)),
  })

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {skill ? 'Edit certification' : 'Certify a technician'}
          </DialogTitle>
          <DialogDescription>
            Certifying someone lets them take jobs of this device class, and —
            with QC sign-off — approve other people's work on it.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <FormField label="Technician">
            <Select
              value={userId}
              disabled={Boolean(skill)}
              onChange={(e) => setUserId(e.target.value)}
            >
              <option value="">Select…</option>
              {users.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.full_name} — {u.role}
                </option>
              ))}
            </Select>
          </FormField>
          <FormField label="Device class">
            <Select
              value={category}
              disabled={Boolean(skill)}
              onChange={(e) => setCategory(e.target.value as DeviceCategory)}
            >
              {CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </Select>
          </FormField>
          <FormField label="Level">
            <Select
              value={String(level)}
              onChange={(e) => setLevel(Number(e.target.value))}
            >
              {LEVELS.map((l) => (
                <option key={l} value={l}>
                  {l} — {LEVEL_LABEL[l]}
                </option>
              ))}
            </Select>
          </FormField>
          <FormField
            label="QC sign-off"
            hint="Only holders of this may approve QC for the class — a technician cannot pass their own work."
          >
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={canQc}
                onChange={(e) => setCanQc(e.target.checked)}
              />
              May approve QC for this device class
            </label>
          </FormField>
          <FormField label="Certified on">
            <Input
              type="date"
              value={certifiedAt}
              onChange={(e) => setCertifiedAt(e.target.value)}
            />
          </FormField>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={!userId || save.isPending} onClick={() => save.mutate()}>
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
