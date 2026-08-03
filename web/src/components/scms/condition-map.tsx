import { useMemo, useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
import { cn } from '@/lib/utils'
import type {
  ConditionZone,
  DamageSeverity,
  DamageType,
} from '@/lib/types'

/**
 * The interactive visual condition map (SCMS proposal Module 1, §2 step 3).
 *
 * "The agent is presented with an interactive layout mapping common physical
 * damage spots. The agent checks off pre-existing conditions (e.g. glass
 * hairline crack, frame scuffs, deep dents, water indicators activated)."
 *
 * Hotspots come from the API as NORMALISED 0–1 coordinates, so one component
 * renders a handset, a TV, a fridge and an air-conditioner from the same code
 * — the outline behind them is drawn as a plain rounded rectangle sized to the
 * face, not per-device artwork nobody would maintain.
 *
 * ACCESSIBILITY: every hotspot is a real <button> with a text label, and the
 * list beside the diagram is not decorative — it is the same control surface
 * for anyone who cannot use the pin-drop, and the primary one on a phone-sized
 * screen where the outline is small.
 */

export interface ConditionMarkDraft {
  zone_id: string
  damage: DamageType
  severity: DamageSeverity
  note?: string
}

const DAMAGE_LABELS: Record<DamageType, string> = {
  SCRATCH: 'Scratch',
  HAIRLINE_CRACK: 'Hairline crack',
  CRACK: 'Crack',
  SHATTERED: 'Shattered',
  DENT: 'Dent',
  SCUFF: 'Scuff',
  CHIP: 'Chip',
  DISCOLOURATION: 'Discolouration',
  CORROSION: 'Corrosion',
  BURN: 'Burn mark',
  MISSING_PART: 'Missing part',
  LOOSE_PART: 'Loose part',
  WATER_INGRESS: 'Water ingress',
  LIQUID_INDICATOR_TRIPPED: 'Liquid indicator tripped',
  PREVIOUS_REPAIR: 'Evidence of previous repair',
  OTHER: 'Other',
}

const DAMAGE_ORDER: DamageType[] = [
  'SCRATCH',
  'SCUFF',
  'HAIRLINE_CRACK',
  'CRACK',
  'SHATTERED',
  'CHIP',
  'DENT',
  'DISCOLOURATION',
  'CORROSION',
  'BURN',
  'MISSING_PART',
  'LOOSE_PART',
  'WATER_INGRESS',
  'LIQUID_INDICATOR_TRIPPED',
  'PREVIOUS_REPAIR',
  'OTHER',
]

const SEVERITIES: DamageSeverity[] = ['MINOR', 'MODERATE', 'SEVERE']

/** Severity drives the pin colour — the fastest read on a busy outline. */
const SEVERITY_DOT: Record<DamageSeverity, string> = {
  MINOR: 'bg-amber-500 ring-amber-500/30',
  MODERATE: 'bg-orange-600 ring-orange-600/30',
  SEVERE: 'bg-red-600 ring-red-600/30',
}

const SEVERITY_BADGE: Record<DamageSeverity, 'secondary' | 'warning' | 'destructive'> = {
  MINOR: 'secondary',
  MODERATE: 'warning',
  SEVERE: 'destructive',
}

export function ConditionMap({
  zones,
  marks,
  onChange,
  disabled,
}: {
  zones: ConditionZone[]
  marks: ConditionMarkDraft[]
  onChange: (marks: ConditionMarkDraft[]) => void
  disabled?: boolean
}) {
  const faces = useMemo(() => {
    const set = new Set(zones.map((z) => z.face))
    // FRONT first: it is where most damage is, and where an agent starts.
    return ['FRONT', 'BACK', 'SIDE'].filter((f) => set.has(f))
  }, [zones])

  const [face, setFace] = useState<string>(faces[0] ?? 'FRONT')
  const [selectedZone, setSelectedZone] = useState<string | null>(null)

  const activeFace = faces.includes(face) ? face : (faces[0] ?? 'FRONT')
  const faceZones = zones.filter((z) => z.face === activeFace)

  const marksByZone = useMemo(() => {
    const map = new Map<string, ConditionMarkDraft[]>()
    for (const m of marks) {
      const list = map.get(m.zone_id)
      if (list) list.push(m)
      else map.set(m.zone_id, [m])
    }
    return map
  }, [marks])

  const zoneById = useMemo(
    () => new Map(zones.map((z) => [z.id, z])),
    [zones],
  )

  function addMark(zoneId: string, damage: DamageType) {
    // (zone, damage) is the unique key server-side, so adding the same pair
    // twice is a no-op rather than a duplicate the API would then reject.
    if (marks.some((m) => m.zone_id === zoneId && m.damage === damage)) return
    onChange([...marks, { zone_id: zoneId, damage, severity: 'MINOR' }])
  }

  function updateMark(index: number, patch: Partial<ConditionMarkDraft>) {
    onChange(marks.map((m, i) => (i === index ? { ...m, ...patch } : m)))
  }

  function removeMark(index: number) {
    onChange(marks.filter((_, i) => i !== index))
  }

  if (zones.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No condition hotspots are configured for this device class yet. An
        administrator can add them under Configuration.
      </p>
    )
  }

  return (
    <div className="flex flex-col gap-4 lg:flex-row">
      {/* -- The outline --------------------------------------------------- */}
      <div className="flex flex-col gap-2 lg:w-[300px] lg:shrink-0">
        {faces.length > 1 && (
          <div className="flex gap-1">
            {faces.map((f) => (
              <Button
                key={f}
                type="button"
                size="sm"
                variant={f === activeFace ? 'default' : 'outline'}
                onClick={() => setFace(f)}
              >
                {f.charAt(0) + f.slice(1).toLowerCase()}
              </Button>
            ))}
          </div>
        )}

        <div className="relative aspect-[9/16] w-full max-w-[280px] self-center overflow-hidden rounded-[2rem] border-2 border-dashed bg-muted/30">
          {faceZones.map((zone) => {
            const zoneMarks = marksByZone.get(zone.id) ?? []
            const worst = worstSeverity(zoneMarks)
            const isSelected = selectedZone === zone.id
            return (
              <button
                key={zone.id}
                type="button"
                disabled={disabled}
                title={`${zone.label}${
                  zoneMarks.length
                    ? ` — ${zoneMarks.map((m) => DAMAGE_LABELS[m.damage]).join(', ')}`
                    : ''
                }`}
                aria-label={`${zone.label}: ${
                  zoneMarks.length
                    ? zoneMarks.map((m) => DAMAGE_LABELS[m.damage]).join(', ')
                    : 'no damage recorded'
                }`}
                aria-pressed={zoneMarks.length > 0}
                onClick={() => setSelectedZone(isSelected ? null : zone.id)}
                // Percentage positioning is what makes one renderer work for
                // every device outline — see the component doc comment.
                style={{
                  left: `${zone.x * 100}%`,
                  top: `${zone.y * 100}%`,
                }}
                className={cn(
                  'absolute size-6 -translate-x-1/2 -translate-y-1/2 rounded-full ring-4 transition',
                  'focus-visible:outline-none focus-visible:ring-offset-2 focus-visible:ring-offset-background',
                  worst
                    ? SEVERITY_DOT[worst]
                    : 'bg-background ring-border hover:ring-primary/40',
                  isSelected && 'scale-125 ring-primary',
                  disabled && 'cursor-not-allowed opacity-60',
                )}
              >
                <span className="sr-only">{zone.label}</span>
                {zoneMarks.length > 1 && (
                  <span className="absolute -right-1 -top-1 flex size-3.5 items-center justify-center rounded-full bg-foreground text-[9px] font-medium text-background">
                    {zoneMarks.length}
                  </span>
                )}
              </button>
            )
          })}
        </div>

        <p className="text-center text-xs text-muted-foreground">
          Tap a point to record damage there.
        </p>
      </div>

      {/* -- The list (the real control surface) ---------------------------- */}
      <div className="flex min-w-0 flex-1 flex-col gap-3">
        {selectedZone && (
          <div className="rounded-lg border bg-muted/30 p-3">
            <p className="mb-2 text-sm font-medium">
              {zoneById.get(selectedZone)?.label}
            </p>
            <div className="flex flex-wrap gap-1.5">
              {DAMAGE_ORDER.map((d) => {
                const already = marks.some(
                  (m) => m.zone_id === selectedZone && m.damage === d,
                )
                return (
                  <Button
                    key={d}
                    type="button"
                    size="sm"
                    variant={already ? 'secondary' : 'outline'}
                    disabled={disabled || already}
                    onClick={() => addMark(selectedZone, d)}
                  >
                    {DAMAGE_LABELS[d]}
                  </Button>
                )
              })}
            </div>
          </div>
        )}

        {marks.length === 0 ? (
          <p className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
            No pre-existing damage recorded. That is a valid finding — saving an
            empty map records that the device was checked and found unmarked.
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {marks.map((m, i) => {
              const zone = zoneById.get(m.zone_id)
              return (
                <li
                  key={`${m.zone_id}:${m.damage}`}
                  className="flex flex-wrap items-center gap-2 rounded-lg border p-2"
                >
                  <Badge variant={SEVERITY_BADGE[m.severity]}>
                    {DAMAGE_LABELS[m.damage]}
                  </Badge>
                  <span className="text-sm">{zone?.label ?? 'Unknown area'}</span>
                  <Select
                    className="h-8 w-auto"
                    value={m.severity}
                    disabled={disabled}
                    onChange={(e) =>
                      updateMark(i, {
                        severity: e.target.value as DamageSeverity,
                      })
                    }
                  >
                    {SEVERITIES.map((s) => (
                      <option key={s} value={s}>
                        {s.charAt(0) + s.slice(1).toLowerCase()}
                      </option>
                    ))}
                  </Select>
                  <Input
                    className="h-8 min-w-[8rem] flex-1"
                    placeholder="Note (optional)"
                    value={m.note ?? ''}
                    disabled={disabled}
                    onChange={(e) => updateMark(i, { note: e.target.value })}
                  />
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    disabled={disabled}
                    onClick={() => removeMark(i)}
                  >
                    Remove
                  </Button>
                </li>
              )
            })}
          </ul>
        )}
      </div>
    </div>
  )
}

/** The most serious severity recorded on a zone — drives the pin colour. */
function worstSeverity(marks: ConditionMarkDraft[]): DamageSeverity | null {
  if (marks.length === 0) return null
  if (marks.some((m) => m.severity === 'SEVERE')) return 'SEVERE'
  if (marks.some((m) => m.severity === 'MODERATE')) return 'MODERATE'
  return 'MINOR'
}

export { DAMAGE_LABELS }
