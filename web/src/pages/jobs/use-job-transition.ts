import { useMutation, useQueryClient, type QueryKey } from '@tanstack/react-query'
import { toast } from 'sonner'
import type { PaginatedResponse } from '@triserve/shared'
import { api, apiErrorMessage } from '@/lib/api'
import type { JobWire, TransitionResult } from '@/lib/types'

interface TransitionVars {
  jobId: string
  toStateCode: string
  note?: string
}

/**
 * Shared POST /jobs/{id}/transition mutation (Task 1.5) used by the Kanban
 * board (drag-and-drop) and the job detail page (transition buttons).
 *
 * When `listQueryKey` is given (the board), the move is applied
 * OPTIMISTICALLY to that cached list so the drag feels instant. Either way,
 * on settle we invalidate BOTH the board's list queries (by their shared
 * root key) and the single-job query — which is what makes an illegal/
 * unauthorized move "snap back" (422 → revert + toast the server's reason)
 * and what makes a requires_approval move visibly "stay put" (the job's
 * state genuinely hasn't changed server-side yet; we just surface that it's
 * pending a manager's decision).
 */
export function useJobTransition(listQueryKey?: QueryKey) {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async ({ jobId, toStateCode, note }: TransitionVars) =>
      (
        await api.post<TransitionResult>(`/jobs/${jobId}/transition`, {
          to_state_code: toStateCode,
          ...(note ? { note } : {}),
        })
      ).data,

    onMutate: async ({ jobId, toStateCode }: TransitionVars) => {
      if (!listQueryKey) return undefined
      await queryClient.cancelQueries({ queryKey: listQueryKey })
      const previous = queryClient.getQueryData<PaginatedResponse<JobWire>>(listQueryKey)
      queryClient.setQueryData<PaginatedResponse<JobWire>>(listQueryKey, (old) =>
        old
          ? {
              ...old,
              data: old.data.map((j) =>
                j.id === jobId ? { ...j, state_code: toStateCode } : j,
              ),
            }
          : old,
      )
      return { previous }
    },

    onError: (err, _vars, context) => {
      if (listQueryKey && context?.previous) {
        queryClient.setQueryData(listQueryKey, context.previous)
      }
      toast.error(apiErrorMessage(err))
    },

    onSuccess: (result) => {
      if (result.held) {
        toast.warning('Pending approval', {
          description: `This move requires manager approval — the job stays in "${result.job.state_label}" until it's decided.`,
        })
      } else {
        toast.success(`Moved to ${result.job.state_label}`)
      }
    },

    onSettled: (_data, _err, vars) => {
      if (listQueryKey) {
        void queryClient.invalidateQueries({ queryKey: [listQueryKey[0]] })
      }
      void queryClient.invalidateQueries({ queryKey: ['job', vars.jobId] })
    },
  })
}
