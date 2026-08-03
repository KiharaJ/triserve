import { useQuery } from '@tanstack/react-query'
import { ChevronRight, Search, X } from 'lucide-react'
import { useState } from 'react'
import type { PaginatedResponse } from '@triserve/shared'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { api } from '@/lib/api'
import { formatMoney } from '@/lib/format'
import { cn } from '@/lib/utils'
import type { DeviceCategory, SymptomNode } from '@/lib/types'

/**
 * The cascading symptom picker (SCMS proposal Module 1, §2 step 4).
 *
 * "Instead of letting agents write ambiguous text descriptions like 'phone
 * broken', the system enforces a cascading diagnostic dropdown: Category
 * (e.g. Display) → Sub-Category (e.g. Backlight) → Symptom Trigger (e.g.
 * Flickers only when warm)."
 *
 * TWO ways in, because a counter has two kinds of agent:
 *
 *  - the CASCADE, which teaches the vocabulary and is what a new agent uses;
 *  - a free-text SEARCH over leaves, which is what someone who has booked a
 *    thousand jobs actually wants. It produces the same stored value, so data
 *    quality is identical — forcing the cascade on them would just slow the
 *    queue down.
 *
 * Only a LEAF can be selected. That is the whole point: "Display" is not a
 * diagnosis, and the API refuses one anyway.
 */
export function SymptomPicker({
  category,
  value,
  onChange,
  disabled,
}: {
  category: DeviceCategory
  value: SymptomNode | null
  onChange: (node: SymptomNode | null) => void
  disabled?: boolean
}) {
  /** The chosen ancestors, root-first — the breadcrumb the agent walked. */
  const [trail, setTrail] = useState<SymptomNode[]>([])
  const [search, setSearch] = useState('')
  const query = search.trim()

  const parentId = trail.length > 0 ? trail[trail.length - 1].id : undefined

  const tier = useQuery({
    queryKey: ['symptom-nodes', category, parentId ?? 'root'],
    enabled: query.length < 2,
    queryFn: async () => {
      const res = await api.get<PaginatedResponse<SymptomNode>>(
        '/symptom-nodes',
        { params: { category, parent_id: parentId, page_size: 100 } },
      )
      return res.data.data
    },
  })

  const results = useQuery({
    // Searching is a different question from browsing, so it gets its own key
    // rather than overloading the tier query and fighting over the cache.
    queryKey: ['symptom-search', category, query],
    enabled: query.length >= 2,
    queryFn: async () => {
      const res = await api.get<PaginatedResponse<SymptomNode>>(
        '/symptom-nodes',
        { params: { category, q: query, page_size: 40 } },
      )
      return res.data.data
    },
  })

  function pick(node: SymptomNode) {
    if (node.is_leaf) {
      onChange(node)
      setSearch('')
      return
    }
    setTrail((t) => [...t, node])
  }

  if (value) {
    return (
      <div className="flex flex-wrap items-center gap-2 rounded-lg border bg-muted/30 p-3">
        <div className="min-w-0 flex-1">
          {value.path.length > 0 && (
            <p className="truncate text-xs text-muted-foreground">
              {value.path.join(' › ')}
            </p>
          )}
          <p className="text-sm font-medium">{value.label}</p>
          {(value.estimate_amount || value.estimate_minutes) && (
            <p className="mt-0.5 text-xs text-muted-foreground">
              {value.estimate_amount && (
                <>
                  Indicative{' '}
                  {formatMoney(
                    value.estimate_amount,
                    value.estimate_currency ?? 'TZS',
                  )}
                </>
              )}
              {value.estimate_amount && value.estimate_minutes ? ' · ' : ''}
              {value.estimate_minutes && <>~{value.estimate_minutes} min bench</>}
            </p>
          )}
        </div>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={disabled}
          onClick={() => {
            onChange(null)
            setTrail([])
          }}
        >
          <X className="size-3.5" /> Change
        </Button>
      </div>
    )
  }

  const searching = query.length >= 2
  const list = searching ? (results.data ?? []) : (tier.data ?? [])
  const loading = searching ? results.isPending : tier.isPending

  return (
    <div className="flex flex-col gap-2">
      <div className="relative">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input
          className="pl-8"
          placeholder="Search symptoms, or pick below…"
          value={search}
          disabled={disabled}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>

      {!searching && trail.length > 0 && (
        <div className="flex flex-wrap items-center gap-1 text-xs">
          <button
            type="button"
            className="text-muted-foreground hover:underline"
            onClick={() => setTrail([])}
          >
            All
          </button>
          {trail.map((node, i) => (
            <span key={node.id} className="flex items-center gap-1">
              <ChevronRight className="size-3 text-muted-foreground" />
              <button
                type="button"
                className={cn(
                  i === trail.length - 1
                    ? 'font-medium'
                    : 'text-muted-foreground hover:underline',
                )}
                onClick={() => setTrail((t) => t.slice(0, i + 1))}
              >
                {node.label}
              </button>
            </span>
          ))}
        </div>
      )}

      <div className="max-h-64 overflow-y-auto rounded-lg border">
        {loading ? (
          <p className="p-3 text-sm text-muted-foreground">Loading…</p>
        ) : list.length === 0 ? (
          <p className="p-3 text-sm text-muted-foreground">
            {searching
              ? 'No symptom matches that. Try a different word, or browse the categories.'
              : 'Nothing configured at this level yet.'}
          </p>
        ) : (
          <ul className="divide-y">
            {list.map((node) => (
              <li key={node.id}>
                <button
                  type="button"
                  disabled={disabled}
                  onClick={() => pick(node)}
                  className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-accent disabled:opacity-60"
                >
                  <span className="min-w-0 flex-1">
                    {searching && node.path.length > 0 && (
                      <span className="block truncate text-xs text-muted-foreground">
                        {node.path.join(' › ')}
                      </span>
                    )}
                    {node.label}
                  </span>
                  {node.is_leaf ? (
                    node.estimate_amount ? (
                      <Badge variant="outline">
                        {formatMoney(
                          node.estimate_amount,
                          node.estimate_currency ?? 'TZS',
                        )}
                      </Badge>
                    ) : null
                  ) : (
                    <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
                  )}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}
