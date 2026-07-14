import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import type { PaginatedResponse } from '@triserve/shared'
import { SearchPicker } from '@/components/shared/search-picker'
import { Select } from '@/components/ui/select'
import { api } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import type { JobWire, UserWire, WarrantyStatus } from '@/lib/types'

/**
 * Pick a job card: optionally filter by assigned engineer first (so you can
 * browse one technician's jobs), then search by job #, IMEI or phone and
 * select. Reused wherever a job must be chosen (invoices, warranty claims, …).
 */
export function JobPicker({
  selectedLabel,
  onSelect,
  onClear,
  warrantyStatus,
  placeholder = 'Search job # / IMEI / phone…',
}: {
  selectedLabel: string | null
  onSelect: (job: JobWire) => void
  onClear: () => void
  /** Restrict the search to a warranty class (e.g. 'IW' for claims). */
  warrantyStatus?: WarrantyStatus
  placeholder?: string
}) {
  const { can, user } = useAuth()
  const [engineer, setEngineer] = useState('')

  // Technicians never see others' jobs server-side, so the filter is hidden
  // for them (and for anyone without user.read).
  const technicians = useQuery({
    queryKey: ['users', 'technicians'],
    enabled: can('user.read') && user?.role !== 'TECHNICIAN',
    queryFn: async () =>
      (
        await api.get<PaginatedResponse<UserWire>>('/users', {
          params: { role: 'TECHNICIAN', active: true, page_size: 100 },
        })
      ).data.data,
  })

  return (
    <div className="flex flex-col gap-2">
      {!selectedLabel && technicians.data && technicians.data.length > 0 && (
        <Select
          value={engineer}
          onChange={(e) => setEngineer(e.target.value)}
          aria-label="Filter jobs by engineer"
        >
          <option value="">Any engineer</option>
          {technicians.data.map((t) => (
            <option key={t.id} value={t.id}>
              {t.full_name}
            </option>
          ))}
        </Select>
      )}
      <SearchPicker<JobWire>
        placeholder={
          engineer ? 'Search, or leave blank to list this engineer’s jobs…' : placeholder
        }
        queryKey="job-picker"
        deps={[engineer, warrantyStatus]}
        allowEmpty={!!engineer}
        selectedLabel={selectedLabel}
        queryFn={async (q) =>
          (
            await api.get<PaginatedResponse<JobWire>>('/jobs', {
              params: {
                ...(q ? { q } : {}),
                ...(engineer ? { assigned_engineer_id: engineer } : {}),
                ...(warrantyStatus ? { warranty_status: warrantyStatus } : {}),
                page_size: 10,
              },
            })
          ).data.data
        }
        getKey={(j) => j.id}
        renderItem={(j) => (
          <>
            <span className="font-mono font-medium">{j.job_no}</span>
            <span className="text-xs text-muted-foreground">
              {j.state_label}
              {j.fault_reported ? ` · ${j.fault_reported}` : ''}
            </span>
          </>
        )}
        onSelect={onSelect}
        onClear={onClear}
      />
    </div>
  )
}
