import { useQuery } from '@tanstack/react-query'
import { Search, X } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useDebouncedValue } from '@/lib/use-debounced-value'

interface SearchPickerProps<T> {
  placeholder?: string
  /** react-query cache namespace for the search results. */
  queryKey: string
  minChars?: number
  queryFn: (q: string) => Promise<T[]>
  getKey: (item: T) => string
  renderItem: (item: T) => ReactNode
  /** When set, shows the chosen item as a chip with a clear button. */
  selectedLabel?: string | null
  onSelect: (item: T) => void
  onClear: () => void
}

/**
 * Lightweight async search-select: type ≥minChars, pick from a live-queried
 * dropdown. Once chosen it collapses to a labelled chip with a clear button.
 * Used to attach a customer or a job card to an invoice.
 */
export function SearchPicker<T>({
  placeholder,
  queryKey,
  minChars = 2,
  queryFn,
  getKey,
  renderItem,
  selectedLabel,
  onSelect,
  onClear,
}: SearchPickerProps<T>) {
  const [q, setQ] = useState('')
  const [open, setOpen] = useState(false)
  const debounced = useDebouncedValue(q, 300)

  const results = useQuery({
    queryKey: [queryKey, debounced],
    enabled: open && debounced.trim().length >= minChars,
    queryFn: () => queryFn(debounced.trim()),
  })

  if (selectedLabel) {
    return (
      <div className="flex items-center justify-between gap-2 rounded-md border bg-muted/40 px-3 py-2 text-sm">
        <span className="truncate font-medium">{selectedLabel}</span>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-6 shrink-0"
          onClick={onClear}
          aria-label="Clear selection"
        >
          <X className="size-4" />
        </Button>
      </div>
    )
  }

  return (
    <div className="relative">
      <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
      <Input
        value={q}
        placeholder={placeholder}
        className="pl-7"
        onChange={(e) => {
          setQ(e.target.value)
          setOpen(true)
        }}
        onFocus={() => setOpen(true)}
      />
      {open && debounced.trim().length >= minChars && (
        <div className="absolute z-50 mt-1 max-h-60 w-full overflow-y-auto rounded-md border bg-popover p-1 text-popover-foreground shadow-lg">
          {results.isPending && (
            <p className="px-2 py-1.5 text-sm text-muted-foreground">Searching…</p>
          )}
          {results.data?.length === 0 && (
            <p className="px-2 py-1.5 text-sm text-muted-foreground">No matches</p>
          )}
          {results.data?.map((item) => (
            <button
              key={getKey(item)}
              type="button"
              className="flex w-full flex-col items-start rounded-sm px-2 py-1.5 text-left text-sm hover:bg-accent"
              onClick={() => {
                onSelect(item)
                setOpen(false)
                setQ('')
              }}
            >
              {renderItem(item)}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
