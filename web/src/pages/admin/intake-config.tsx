import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useMemo, useRef, useState, type MouseEvent } from 'react'
import { toast } from 'sonner'
import type { PaginatedResponse } from '@triserve/shared'
import { FormField } from '@/components/shared/form-field'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { api, apiErrorMessage } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { formatMoney } from '@/lib/format'
import {
  SYMPTOM_SUGGESTIONS,
  ZONE_SUGGESTIONS,
} from '@/lib/intake-suggestions'
import { cn } from '@/lib/utils'
import type {
  ConditionZone,
  DeviceCategory,
  FaultCodeWire,
  SymptomNode,
} from '@/lib/types'

const CATEGORIES: DeviceCategory[] = ['HHP', 'CE', 'AC', 'REF', 'OTHER']
const FACES = ['FRONT', 'BACK', 'SIDE']

/**
 * Intake configuration (SCMS proposal Module 1, §2 steps 3–4): the symptom
 * tree the counter picks from at step 4, and the condition-map hotspots it
 * taps at step 3. Both had full config.manage-gated CRUD on the API since
 * Task 1.2/1.3 but no admin page — the only way to add either was editing
 * prisma/seed.ts and re-seeding, which doesn't reach a live company at all
 * (seed.ts only runs on a fresh company or the test suite; see the
 * `intake_evidence_complete` guard, which blocks a job that has neither).
 */
export function IntakeConfigPage() {
  const { can } = useAuth()
  const canManage = can('config.manage')
  const [category, setCategory] = useState<DeviceCategory>('HHP')

  return (
    <div className="flex flex-col gap-4">
      <FormField label="Device class" className="w-48">
        <Select
          value={category}
          onChange={(e) => setCategory(e.target.value as DeviceCategory)}
        >
          {CATEGORIES.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </Select>
      </FormField>

      <Tabs defaultValue="symptoms">
        <TabsList>
          <TabsTrigger value="symptoms">Symptom tree</TabsTrigger>
          <TabsTrigger value="condition">Condition hotspots</TabsTrigger>
        </TabsList>
        <TabsContent value="symptoms">
          <SymptomTreeEditor category={category} canManage={canManage} />
        </TabsContent>
        <TabsContent value="condition">
          <ConditionZoneEditor category={category} canManage={canManage} />
        </TabsContent>
      </Tabs>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Symptom tree
// ---------------------------------------------------------------------------

interface SymptomFormState {
  id?: string
  code: string
  label: string
  parent_id: string | null
  fault_code_id: string
  estimate: string
  estimate_minutes: string
  sort_order: string
  active: boolean
}

function emptySymptomForm(parentId: string | null): SymptomFormState {
  return {
    code: '',
    label: '',
    parent_id: parentId,
    fault_code_id: '',
    estimate: '',
    estimate_minutes: '',
    sort_order: '0',
    active: true,
  }
}

function SymptomTreeEditor({
  category,
  canManage,
}: {
  category: DeviceCategory
  canManage: boolean
}) {
  const queryClient = useQueryClient()
  const [form, setForm] = useState<SymptomFormState | null>(null)

  const nodes = useQuery({
    queryKey: ['symptom-nodes', 'admin', category],
    // GET /symptom-nodes with no parent_id returns only the ROOT tier — it's
    // built for the cascading picker (one tier at a time), not "give me the
    // whole tree". Walk it level by level, using is_leaf to know when a
    // branch has no more children, and flatten everything into one array so
    // the tree below can be built from it exactly like the picker's trail.
    queryFn: async () => {
      const all: SymptomNode[] = []
      let frontier: (string | undefined)[] = [undefined]
      while (frontier.length > 0) {
        const tiers = await Promise.all(
          frontier.map((parentId) =>
            api
              .get<PaginatedResponse<SymptomNode>>('/symptom-nodes', {
                params: {
                  category,
                  page_size: 100,
                  ...(parentId ? { parent_id: parentId } : {}),
                },
              })
              .then((r) => r.data.data),
          ),
        )
        const flat = tiers.flat()
        all.push(...flat)
        frontier = flat.filter((n) => !n.is_leaf).map((n) => n.id)
      }
      return all
    },
  })

  // For the optional "Fault code" link on a symptom leaf — the same lookup
  // Admin → Configuration → Fault codes manages, so a symptom can point at
  // one that already exists rather than duplicating the concept.
  const faultCodes = useQuery({
    queryKey: ['fault-codes', 'admin'],
    queryFn: async () =>
      (
        await api.get<PaginatedResponse<FaultCodeWire>>('/fault-codes', {
          params: { page_size: 100, active: true },
        })
      ).data.data,
  })

  const byParent = useMemo(() => {
    const map = new Map<string, SymptomNode[]>()
    for (const n of nodes.data ?? []) {
      const key = n.parent_id ?? 'root'
      const list = map.get(key)
      if (list) list.push(n)
      else map.set(key, [n])
    }
    for (const list of map.values()) {
      list.sort((a, b) => a.sort_order - b.sort_order)
    }
    return map
  }, [nodes.data])

  const nodeById = useMemo(
    () => new Map((nodes.data ?? []).map((n) => [n.id, n])),
    [nodes.data],
  )

  const existingCodes = useMemo(
    () => new Set((nodes.data ?? []).map((n) => n.code)),
    [nodes.data],
  )

  // Suggestions relevant to WHERE the dialog is adding — root-level examples
  // when adding a root, or examples filed under a matching parent code when
  // adding a child — with anything the company already has filtered out.
  const suggestions = useMemo(() => {
    if (!form || form.id) return []
    const parentCode = form.parent_id
      ? (nodeById.get(form.parent_id)?.code ?? null)
      : null
    return SYMPTOM_SUGGESTIONS[category].filter(
      (s) => s.parentCode === parentCode && !existingCodes.has(s.code),
    )
  }, [form, category, nodeById, existingCodes])

  // Native browser autocomplete on the Code field itself — broader than the
  // context-filtered chips above (every known code for this category,
  // typed-to-filter), for when the admin already knows what they want to
  // type rather than browsing the suggestion chips.
  const codeOptions = useMemo(() => {
    const codes = new Set<string>(existingCodes)
    for (const s of SYMPTOM_SUGGESTIONS[category]) codes.add(s.code)
    return Array.from(codes).sort()
  }, [existingCodes, category])

  const labelBySuggestionCode = useMemo(
    () => new Map(SYMPTOM_SUGGESTIONS[category].map((s) => [s.code, s.label])),
    [category],
  )

  const save = useMutation({
    mutationFn: async (f: SymptomFormState) => {
      const body = {
        code: f.code.trim().toUpperCase(),
        label: f.label.trim(),
        parent_id: f.parent_id ?? undefined,
        category,
        fault_code_id: f.fault_code_id || null,
        ...(f.estimate.trim()
          ? {
              estimate_amount: String(Math.round(Number(f.estimate) * 100)),
              estimate_currency: 'TZS',
            }
          : {}),
        ...(f.estimate_minutes.trim()
          ? { estimate_minutes: Number(f.estimate_minutes) }
          : {}),
        sort_order: Number(f.sort_order) || 0,
        active: f.active,
      }
      return f.id
        ? api.patch(`/symptom-nodes/${f.id}`, body)
        : api.post('/symptom-nodes', body)
    },
    onSuccess: async () => {
      toast.success('Symptom saved')
      setForm(null)
      await queryClient.invalidateQueries({ queryKey: ['symptom-nodes'] })
    },
    onError: (e) => toast.error(apiErrorMessage(e)),
  })

  const remove = useMutation({
    mutationFn: async (id: string) => api.delete(`/symptom-nodes/${id}`),
    onSuccess: async () => {
      toast.success('Symptom removed')
      await queryClient.invalidateQueries({ queryKey: ['symptom-nodes'] })
    },
    onError: (e) => toast.error(apiErrorMessage(e)),
  })

  function openEdit(n: SymptomNode) {
    setForm({
      id: n.id,
      code: n.code,
      label: n.label,
      parent_id: n.parent_id,
      fault_code_id: n.fault_code_id ?? '',
      estimate: n.estimate_amount
        ? String(Number(n.estimate_amount) / 100)
        : '',
      estimate_minutes:
        n.estimate_minutes != null ? String(n.estimate_minutes) : '',
      sort_order: String(n.sort_order),
      active: n.active,
    })
  }

  function renderNode(n: SymptomNode, depth: number) {
    const children = byParent.get(n.id) ?? []
    return (
      <div key={n.id} className="flex flex-col gap-1">
        <div
          className={cn(
            'flex flex-wrap items-center gap-2 rounded-md border p-2 text-sm',
            !n.active && 'opacity-50',
          )}
          style={{ marginLeft: depth * 20 }}
        >
          {n.is_leaf ? (
            <Badge variant="outline">leaf</Badge>
          ) : (
            <Badge variant="secondary">group</Badge>
          )}
          <span className="font-medium">{n.label}</span>
          <span className="font-mono text-xs text-muted-foreground">
            {n.code}
          </span>
          {n.estimate_amount && (
            <span className="text-xs text-muted-foreground">
              ~{formatMoney(n.estimate_amount, n.estimate_currency ?? 'TZS')}
            </span>
          )}
          {!n.active && <Badge variant="secondary">inactive</Badge>}
          {canManage && (
            <div className="ml-auto flex gap-1">
              <Button
                size="xs"
                variant="ghost"
                onClick={() => setForm(emptySymptomForm(n.id))}
              >
                + Child
              </Button>
              <Button size="xs" variant="ghost" onClick={() => openEdit(n)}>
                Edit
              </Button>
              <Button
                size="xs"
                variant="ghost"
                disabled={remove.isPending}
                onClick={() => remove.mutate(n.id)}
              >
                Remove
              </Button>
            </div>
          )}
        </div>
        {children.map((c) => renderNode(c, depth + 1))}
      </div>
    )
  }

  const roots = byParent.get('root') ?? []

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center justify-between gap-2">
          <span>Symptom tree — {category}</span>
          {canManage && (
            <Button size="sm" onClick={() => setForm(emptySymptomForm(null))}>
              + Add root symptom
            </Button>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-1.5">
        {nodes.isPending && (
          <p className="text-sm text-muted-foreground">Loading…</p>
        )}
        {roots.length === 0 && !nodes.isPending && (
          <p className="text-sm text-muted-foreground">
            No symptoms configured for {category} yet — the intake picker (and
            the intake_evidence_complete guard) will have nothing to offer until
            you add the first one above.
          </p>
        )}
        {roots.map((n) => renderNode(n, 0))}
      </CardContent>

      {form && (
        <Dialog open onOpenChange={(o) => !o && setForm(null)}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>
                {form.id ? 'Edit symptom' : 'Add symptom'}
              </DialogTitle>
              <DialogDescription>
                {form.parent_id
                  ? `Under "${nodeById.get(form.parent_id)?.label ?? '…'}"`
                  : `Top-level category, ${category}`}
              </DialogDescription>
            </DialogHeader>
            <div className="grid gap-3">
              {suggestions.length > 0 && (
                <div>
                  <p className="mb-1.5 text-sm font-medium">
                    Suggestions — click to fill in, then adjust as needed
                  </p>
                  <div className="flex flex-wrap gap-1.5">
                    {suggestions.map((s) => (
                      <Button
                        key={s.code}
                        type="button"
                        size="xs"
                        variant="outline"
                        onClick={() =>
                          setForm(
                            form && { ...form, code: s.code, label: s.label },
                          )
                        }
                      >
                        {s.label}
                      </Button>
                    ))}
                  </div>
                </div>
              )}
              <FormField
                label="Code"
                hint="Uppercase letters, digits, dots, dashes or underscores. Start typing for suggestions."
              >
                <Input
                  value={form.code}
                  list="symptom-code-suggestions"
                  onChange={(e) => {
                    const code = e.target.value
                    // Picking (or typing exactly) a known suggestion code
                    // fills the label too — only when the admin hasn't
                    // already written one, so it never clobbers real work.
                    const knownLabel = labelBySuggestionCode.get(
                      code.trim().toUpperCase(),
                    )
                    setForm({
                      ...form,
                      code,
                      label:
                        knownLabel && !form.label.trim()
                          ? knownLabel
                          : form.label,
                    })
                  }}
                  placeholder="e.g. DISPLAY.BLANK.DEAD"
                />
                <datalist id="symptom-code-suggestions">
                  {codeOptions.map((c) => (
                    <option key={c} value={c} />
                  ))}
                </datalist>
              </FormField>
              <FormField label="Label">
                <Input
                  value={form.label}
                  onChange={(e) => setForm({ ...form, label: e.target.value })}
                />
              </FormField>
              <FormField
                label="Fault code"
                hint="Optional — links this symptom to a code from Admin → Configuration → Fault codes, for reporting."
              >
                <Select
                  value={form.fault_code_id}
                  onChange={(e) =>
                    setForm({ ...form, fault_code_id: e.target.value })
                  }
                >
                  <option value="">None</option>
                  {(faultCodes.data ?? []).map((fc) => (
                    <option key={fc.id} value={fc.id}>
                      {fc.code} — {fc.label}
                    </option>
                  ))}
                </Select>
              </FormField>
              <FormField
                label="Indicative estimate (TZS)"
                hint="Optional — shown to the customer at the counter, not a formal quote."
              >
                <Input
                  inputMode="numeric"
                  value={form.estimate}
                  onChange={(e) =>
                    setForm({ ...form, estimate: e.target.value })
                  }
                />
              </FormField>
              <FormField label="Estimate time (minutes)">
                <Input
                  inputMode="numeric"
                  value={form.estimate_minutes}
                  onChange={(e) =>
                    setForm({ ...form, estimate_minutes: e.target.value })
                  }
                />
              </FormField>
              <FormField label="Sort order">
                <Input
                  inputMode="numeric"
                  value={form.sort_order}
                  onChange={(e) =>
                    setForm({ ...form, sort_order: e.target.value })
                  }
                />
              </FormField>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={form.active}
                  onChange={(e) =>
                    setForm({ ...form, active: e.target.checked })
                  }
                />
                Active (selectable at the counter)
              </label>
            </div>
            <DialogFooter>
              <Button variant="ghost" onClick={() => setForm(null)}>
                Cancel
              </Button>
              <Button
                disabled={
                  !form.code.trim() || !form.label.trim() || save.isPending
                }
                onClick={() => save.mutate(form)}
              >
                Save
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </Card>
  )
}

// ---------------------------------------------------------------------------
// Condition hotspots
// ---------------------------------------------------------------------------

interface ZoneFormValues {
  code: string
  label: string
  x: number
  y: number
  sort_order: number
  active: boolean
}

function ConditionZoneEditor({
  category,
  canManage,
}: {
  category: DeviceCategory
  canManage: boolean
}) {
  const queryClient = useQueryClient()
  const [face, setFace] = useState('FRONT')
  const [createAt, setCreateAt] = useState<{
    x: number
    y: number
    code?: string
    label?: string
  } | null>(null)
  const [editingZone, setEditingZone] = useState<ConditionZone | null>(null)
  const containerRef = useRef<HTMLDivElement>(null)

  const zones = useQuery({
    queryKey: ['condition-zones', 'admin', category],
    queryFn: async () =>
      (
        await api.get<PaginatedResponse<ConditionZone>>('/condition-zones', {
          params: { category, page_size: 100 },
        })
      ).data.data,
  })

  const faceZones = (zones.data ?? []).filter((z) => z.face === face)

  const existingZoneCodes = useMemo(
    () => new Set((zones.data ?? []).map((z) => z.code)),
    [zones.data],
  )
  const zoneSuggestions = ZONE_SUGGESTIONS[category].filter(
    (s) => s.face === face && !existingZoneCodes.has(s.code),
  )

  const remove = useMutation({
    mutationFn: async (id: string) => api.delete(`/condition-zones/${id}`),
    onSuccess: async () => {
      toast.success('Hotspot removed')
      await queryClient.invalidateQueries({ queryKey: ['condition-zones'] })
    },
    onError: (e) => toast.error(apiErrorMessage(e)),
  })

  function handleOutlineClick(e: MouseEvent<HTMLDivElement>) {
    if (!canManage) return
    // Ignore clicks that landed on a hotspot button (it stops propagation
    // and opens its own edit dialog) — only the bare background creates.
    if (e.target !== containerRef.current || !containerRef.current) return
    const rect = containerRef.current.getBoundingClientRect()
    setCreateAt({
      x: Math.round(((e.clientX - rect.left) / rect.width) * 1000) / 1000,
      y: Math.round(((e.clientY - rect.top) / rect.height) * 1000) / 1000,
    })
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Condition hotspots — {category}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4 lg:flex-row">
        <div className="flex flex-col gap-2 lg:w-[300px] lg:shrink-0">
          <div className="flex gap-1">
            {FACES.map((f) => (
              <Button
                key={f}
                type="button"
                size="sm"
                variant={f === face ? 'default' : 'outline'}
                onClick={() => setFace(f)}
              >
                {f.charAt(0) + f.slice(1).toLowerCase()}
              </Button>
            ))}
          </div>

          <div
            ref={containerRef}
            onClick={handleOutlineClick}
            className={cn(
              'relative aspect-[9/16] w-full max-w-[280px] self-center overflow-hidden rounded-[2rem] border-2 border-dashed bg-muted/30',
              canManage && 'cursor-crosshair',
            )}
          >
            {faceZones.map((z) => (
              <button
                key={z.id}
                type="button"
                title={z.label}
                disabled={!canManage}
                onClick={(e) => {
                  e.stopPropagation()
                  setEditingZone(z)
                }}
                style={{ left: `${z.x * 100}%`, top: `${z.y * 100}%` }}
                className={cn(
                  'absolute size-6 -translate-x-1/2 -translate-y-1/2 rounded-full ring-4 transition hover:scale-110',
                  z.active
                    ? 'bg-primary ring-primary/30'
                    : 'bg-muted-foreground/40 ring-border',
                )}
              >
                <span className="sr-only">{z.label}</span>
              </button>
            ))}
          </div>
          {canManage && (
            <p className="text-center text-xs text-muted-foreground">
              Click the outline to add a hotspot there; click an existing dot to
              edit it.
            </p>
          )}
        </div>

        <div className="flex min-w-0 flex-1 flex-col gap-2">
          {faceZones.length === 0 && (
            <p className="text-sm text-muted-foreground">
              No hotspots on the {face.toLowerCase()} face yet.
            </p>
          )}
          {faceZones.map((z) => (
            <div
              key={z.id}
              className={cn(
                'flex flex-wrap items-center gap-2 rounded-lg border p-2 text-sm',
                !z.active && 'opacity-50',
              )}
            >
              <span className="font-medium">{z.label}</span>
              <span className="font-mono text-xs text-muted-foreground">
                {z.code}
              </span>
              <span className="text-xs text-muted-foreground">
                ({z.x.toFixed(2)}, {z.y.toFixed(2)})
              </span>
              {!z.active && <Badge variant="secondary">inactive</Badge>}
              {canManage && (
                <div className="ml-auto flex gap-1">
                  <Button
                    size="xs"
                    variant="ghost"
                    onClick={() => setEditingZone(z)}
                  >
                    Edit
                  </Button>
                  <Button
                    size="xs"
                    variant="ghost"
                    disabled={remove.isPending}
                    onClick={() => remove.mutate(z.id)}
                  >
                    Remove
                  </Button>
                </div>
              )}
            </div>
          ))}

          {canManage && zoneSuggestions.length > 0 && (
            <div className="mt-2">
              <p className="mb-1.5 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
                Suggested hotspots for this face
              </p>
              <div className="flex flex-wrap gap-1.5">
                {zoneSuggestions.map((s) => (
                  <Button
                    key={s.code}
                    type="button"
                    size="xs"
                    variant="outline"
                    onClick={() =>
                      setCreateAt({
                        x: s.x,
                        y: s.y,
                        code: s.code,
                        label: s.label,
                      })
                    }
                  >
                    + {s.label}
                  </Button>
                ))}
              </div>
            </div>
          )}
        </div>
      </CardContent>

      {createAt && (
        <ZoneDialog
          category={category}
          face={face}
          initial={{
            code: createAt.code ?? '',
            label: createAt.label ?? '',
            x: createAt.x,
            y: createAt.y,
            sort_order: 0,
            active: true,
          }}
          onClose={() => setCreateAt(null)}
          onSaved={async () => {
            setCreateAt(null)
            await queryClient.invalidateQueries({
              queryKey: ['condition-zones'],
            })
          }}
        />
      )}
      {editingZone && (
        <ZoneDialog
          category={category}
          face={face}
          zoneId={editingZone.id}
          initial={{
            code: editingZone.code,
            label: editingZone.label,
            x: editingZone.x,
            y: editingZone.y,
            sort_order: editingZone.sort_order,
            active: editingZone.active,
          }}
          onClose={() => setEditingZone(null)}
          onSaved={async () => {
            setEditingZone(null)
            await queryClient.invalidateQueries({
              queryKey: ['condition-zones'],
            })
          }}
        />
      )}
    </Card>
  )
}

function ZoneDialog({
  category,
  face,
  zoneId,
  initial,
  onClose,
  onSaved,
}: {
  category: DeviceCategory
  face: string
  zoneId?: string
  initial: ZoneFormValues
  onClose: () => void
  onSaved: () => void | Promise<void>
}) {
  const [values, setValues] = useState(initial)

  const save = useMutation({
    mutationFn: async () => {
      const body = {
        category,
        code: values.code.trim().toUpperCase(),
        label: values.label.trim(),
        x: values.x,
        y: values.y,
        face,
        sort_order: values.sort_order,
        active: values.active,
      }
      return zoneId
        ? api.patch(`/condition-zones/${zoneId}`, body)
        : api.post('/condition-zones', body)
    },
    onSuccess: async () => {
      toast.success('Hotspot saved')
      await onSaved()
    },
    onError: (e) => toast.error(apiErrorMessage(e)),
  })

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{zoneId ? 'Edit hotspot' : 'Add hotspot'}</DialogTitle>
          <DialogDescription>
            {face.charAt(0) + face.slice(1).toLowerCase()} face, {category}
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <FormField
            label="Code"
            hint="Uppercase letters, digits or underscores."
          >
            <Input
              value={values.code}
              onChange={(e) => setValues({ ...values, code: e.target.value })}
              placeholder="e.g. SCREEN_TOP_LEFT"
            />
          </FormField>
          <FormField label="Label">
            <Input
              value={values.label}
              onChange={(e) => setValues({ ...values, label: e.target.value })}
              placeholder="e.g. Top-left corner of screen"
            />
          </FormField>
          <div className="grid grid-cols-2 gap-3">
            <FormField label="X (0–1)">
              <Input
                inputMode="decimal"
                value={values.x}
                onChange={(e) =>
                  setValues({ ...values, x: Number(e.target.value) || 0 })
                }
              />
            </FormField>
            <FormField label="Y (0–1)">
              <Input
                inputMode="decimal"
                value={values.y}
                onChange={(e) =>
                  setValues({ ...values, y: Number(e.target.value) || 0 })
                }
              />
            </FormField>
          </div>
          <FormField label="Sort order">
            <Input
              inputMode="numeric"
              value={values.sort_order}
              onChange={(e) =>
                setValues({
                  ...values,
                  sort_order: Number(e.target.value) || 0,
                })
              }
            />
          </FormField>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={values.active}
              onChange={(e) =>
                setValues({ ...values, active: e.target.checked })
              }
            />
            Active (selectable at intake)
          </label>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={
              !values.code.trim() || !values.label.trim() || save.isPending
            }
            onClick={() => save.mutate()}
          >
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
