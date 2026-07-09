import { useQuery } from '@tanstack/react-query'
import type { HealthResponse } from '@triserve/shared'
import { api } from '@/lib/api'

export function DashboardPage() {
  const health = useQuery({
    queryKey: ['health'],
    queryFn: async () => (await api.get<HealthResponse>('/health')).data,
    refetchInterval: 30_000,
  })

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Placeholder dashboard — widgets arrive in later tasks.
      </p>
      <div className="rounded-lg border p-4 text-sm">
        <h2 className="mb-2 font-medium">API status</h2>
        {health.isPending && <p className="text-muted-foreground">Checking…</p>}
        {health.isError && (
          <p className="text-destructive">API unreachable</p>
        )}
        {health.data && (
          <ul className="space-y-1 text-muted-foreground">
            <li>
              service: <span className="text-foreground">{health.data.service}</span>{' '}
              v{health.data.version}
            </li>
            <li>
              status: <span className="text-foreground">{health.data.status}</span>
            </li>
            <li>
              database:{' '}
              <span className="text-foreground">{health.data.db}</span>
            </li>
          </ul>
        )}
      </div>
    </div>
  )
}
