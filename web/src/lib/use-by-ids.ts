import { useQueries } from '@tanstack/react-query'
import { api } from '@/lib/api'

/**
 * GET /jobs list rows (JobWire) carry only customer_id/device_id/
 * assigned_engineer_id — no nested names (see JobDetailWire for the single-
 * job shape that DOES nest them). Rather than N+1 GET /jobs/{id} calls per
 * Kanban card, this fetches each UNIQUE referenced id once (deduped, cached)
 * against its own resource endpoint and returns an id → row Map for the
 * board to read from (Task 1.5).
 */
export function useByIds<T>(
  resource: string,
  ids: Array<string | null | undefined>,
  enabled = true,
): Map<string, T> {
  const unique = Array.from(new Set(ids.filter((id): id is string => Boolean(id))))

  const results = useQueries({
    queries: unique.map((id) => ({
      queryKey: [resource, id],
      queryFn: async () => (await api.get<T>(`/${resource}/${id}`)).data,
      enabled,
      staleTime: 60_000,
    })),
  })

  const map = new Map<string, T>()
  unique.forEach((id, i) => {
    const data = results[i]?.data
    if (data) map.set(id, data)
  })
  return map
}
