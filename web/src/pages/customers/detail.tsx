import { useQuery } from '@tanstack/react-query'
import { useParams, Link } from 'react-router-dom'
import type { PaginatedResponse } from '@triserve/shared'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
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
import { formatDateTime } from '@/lib/format'
import type { CustomerWire, DeviceWire, JobWire, WarrantyStatus } from '@/lib/types'

function warrantyBadge(status: WarrantyStatus) {
  switch (status) {
    case 'IW':
      return <Badge variant="success">IW</Badge>
    case 'OW':
      return <Badge variant="warning">OW</Badge>
    case 'GOODWILL':
      return <Badge variant="secondary">Goodwill</Badge>
    default:
      return <Badge variant="outline">Unknown</Badge>
  }
}

/**
 * Customer 360 stub (Task 1.5, DESIGN.md §4.2/E2, §8 item 9). A seed of the
 * full Phase 5 customer-360 view: profile + their devices + their jobs,
 * wired against what Phase 1 actually exposes today —
 *   GET /customers/{id}, GET /customers/{id}/devices, GET /jobs?customer_id=
 * (the last one is a small Task 1.5 addition to JobListQueryDto; see
 * jobs.service.ts). Purchases/warranty/comms-log/outstanding-balance/
 * lifetime-spend arrive with POS (Phase 3) and warranty (Phase 4) — there is
 * no data to show yet, so this intentionally does not fabricate those
 * sections.
 */
export function CustomerDetailPage() {
  const { id } = useParams<{ id: string }>()
  const { can } = useAuth()

  const customer = useQuery({
    queryKey: ['customer', id],
    queryFn: async () => (await api.get<CustomerWire>(`/customers/${id}`)).data,
    enabled: Boolean(id),
  })

  const devices = useQuery({
    queryKey: ['customer', id, 'devices'],
    queryFn: async () =>
      (await api.get<PaginatedResponse<DeviceWire>>(`/customers/${id}/devices`)).data.data,
    enabled: Boolean(id) && can('device.read'),
  })

  const jobs = useQuery({
    queryKey: ['jobs', 'by-customer', id],
    queryFn: async () =>
      (
        await api.get<PaginatedResponse<JobWire>>('/jobs', {
          params: { customer_id: id, page_size: 100 },
        })
      ).data.data,
    enabled: Boolean(id) && can('job.read'),
  })

  if (customer.isPending) return <p className="text-sm text-muted-foreground">Loading…</p>
  if (customer.isError)
    return <p className="text-sm text-destructive">{apiErrorMessage(customer.error)}</p>
  const c = customer.data
  if (!c) return null

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">{c.name}</CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-2 gap-x-6 gap-y-1 text-sm sm:grid-cols-3">
          <div>
            <span className="text-muted-foreground">Phone: </span>
            {c.phone ?? '—'}
          </div>
          <div>
            <span className="text-muted-foreground">Alt phone: </span>
            {c.alt_phone ?? '—'}
          </div>
          <div>
            <span className="text-muted-foreground">Email: </span>
            {c.email ?? '—'}
          </div>
          <div>
            <span className="text-muted-foreground">Location: </span>
            {c.location ?? '—'}
          </div>
          <div>
            <span className="text-muted-foreground">Preferred language: </span>
            {c.preferred_language}
          </div>
          <div>
            <span className="text-muted-foreground">Dealer: </span>
            {c.is_dealer ? (c.dealer_name ?? 'Yes') : 'No'}
          </div>
          {c.rating !== null && (
            <div>
              <span className="text-muted-foreground">Rating: </span>
              {c.rating}/5
            </div>
          )}
          {c.notes && (
            <div className="col-span-full">
              <span className="text-muted-foreground">Notes: </span>
              {c.notes}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Devices</CardTitle>
        </CardHeader>
        <CardContent>
          {!can('device.read') && (
            <p className="text-sm text-muted-foreground">
              You do not have permission to view devices.
            </p>
          )}
          {can('device.read') && devices.isPending && (
            <p className="text-sm text-muted-foreground">Loading…</p>
          )}
          {can('device.read') && devices.data && devices.data.length === 0 && (
            <p className="text-sm text-muted-foreground">No devices on file.</p>
          )}
          {can('device.read') && devices.data && devices.data.length > 0 && (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Brand / Model</TableHead>
                  <TableHead>Category</TableHead>
                  <TableHead>IMEI / Serial</TableHead>
                  <TableHead>Colour</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {devices.data.map((d) => (
                  <TableRow key={d.id}>
                    <TableCell>
                      {d.brand} {d.model ?? ''}
                    </TableCell>
                    <TableCell>{d.category}</TableCell>
                    <TableCell className="font-mono text-xs">{d.imei_serial ?? '—'}</TableCell>
                    <TableCell>{d.color ?? '—'}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Jobs</CardTitle>
        </CardHeader>
        <CardContent>
          {!can('job.read') && (
            <p className="text-sm text-muted-foreground">
              You do not have permission to view jobs.
            </p>
          )}
          {can('job.read') && jobs.isPending && (
            <p className="text-sm text-muted-foreground">Loading…</p>
          )}
          {can('job.read') && jobs.data && jobs.data.length === 0 && (
            <p className="text-sm text-muted-foreground">No jobs on file.</p>
          )}
          {can('job.read') && jobs.data && jobs.data.length > 0 && (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Job #</TableHead>
                  <TableHead>State</TableHead>
                  <TableHead>Warranty</TableHead>
                  <TableHead>Received</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {jobs.data.map((j) => (
                  <TableRow key={j.id}>
                    <TableCell>
                      <Link to={`/jobs/${j.id}`} className="font-medium hover:underline">
                        {j.job_no}
                      </Link>
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline">{j.state_label}</Badge>
                    </TableCell>
                    <TableCell>{warrantyBadge(j.warranty_status)}</TableCell>
                    <TableCell>{formatDateTime(j.received_at)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
