import { LayoutGrid, List } from 'lucide-react'
import { useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { cn } from '@/lib/utils'
import { JobsBoardPage } from '@/pages/jobs/board'
import { JobsListView } from '@/pages/jobs/list'

type View = 'list' | 'board'
const STORAGE_KEY = 'triserve.jobs.view'

/**
 * Jobs module. Defaults to a scannable LIST (a branch can hold thousands of
 * jobs — a Kanban board only shows one screen / one page), with a toggle to the
 * board for hands-on workflow (drag between states). The choice is remembered.
 *
 * `?view=board` wins over the remembered choice so the board can be LINKED —
 * the workshop nav entry points straight at it, and a bookmark or a message
 * to a colleague lands where it says it will.
 */
export function JobsPage() {
  const [params, setParams] = useSearchParams()
  const fromUrl = params.get('view')
  const [stored, setStored] = useState<View>(
    () => (localStorage.getItem(STORAGE_KEY) as View | null) ?? 'list',
  )
  const view: View = fromUrl === 'board' || fromUrl === 'list' ? fromUrl : stored

  function choose(v: View) {
    localStorage.setItem(STORAGE_KEY, v)
    setStored(v)
    // Keep the URL honest once the user picks for themselves.
    if (fromUrl) {
      params.delete('view')
      setParams(params, { replace: true })
    }
  }

  return (
    <div className="flex h-full flex-col gap-4">
      <div className="flex items-center">
        <div className="inline-flex rounded-lg border bg-muted/40 p-0.5">
          <ViewButton
            active={view === 'list'}
            onClick={() => choose('list')}
            icon={<List className="size-4" />}
            label="List"
          />
          <ViewButton
            active={view === 'board'}
            onClick={() => choose('board')}
            icon={<LayoutGrid className="size-4" />}
            label="Board"
          />
        </div>
      </div>
      {view === 'list' ? <JobsListView /> : <JobsBoardPage />}
    </div>
  )
}

function ViewButton({
  active,
  onClick,
  icon,
  label,
}: {
  active: boolean
  onClick: () => void
  icon: React.ReactNode
  label: string
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors',
        active
          ? 'bg-card text-foreground shadow-sm'
          : 'text-muted-foreground hover:text-foreground',
      )}
    >
      {icon}
      {label}
    </button>
  )
}
