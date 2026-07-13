import { zodResolver } from '@hookform/resolvers/zod'
import { useMutation, useQuery } from '@tanstack/react-query'
import { ShieldCheck } from 'lucide-react'
import { useRef, useState } from 'react'
import { useForm } from 'react-hook-form'
import { Link } from 'react-router-dom'
import { toast } from 'sonner'
import { z } from 'zod'
import type { PaginatedResponse } from '@triserve/shared'
import { BarcodeScanButton } from '@/components/shared/barcode-scan-button'
import { FormField } from '@/components/shared/form-field'
import { SignaturePad, type SignaturePadHandle } from '@/components/shared/signature-pad'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { api, apiErrorMessage } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { formatDate, formatDateTime } from '@/lib/format'
import { useDebouncedValue } from '@/lib/use-debounced-value'
import type {
  BranchWire,
  CustomerWire,
  DeviceCategory,
  FaultCodeWire,
  JobDetailWire,
  ModelWire,
  PreferredLanguageCode,
  UserWire,
  WarrantyRegistrationWire,
  WarrantyStatus,
} from '@/lib/types'

const CATEGORIES: DeviceCategory[] = ['HHP', 'CE', 'AC', 'REF', 'OTHER']
const WARRANTY_STATUSES: WarrantyStatus[] = ['IW', 'OW', 'GOODWILL', 'UNKNOWN']
const WARRANTY_KIND_LABEL: Record<string, string> = {
  STORE: 'store',
  MANUFACTURER: 'manufacturer',
  SAMSUNG: 'Samsung',
}

const fieldsSchema = z.object({
  branch_id: z.string().optional(),
  category: z.enum(['HHP', 'CE', 'AC', 'REF', 'OTHER']),
  imei_serial: z.string().max(100).optional(),
  color: z.string().max(50).optional(),
  fault_reported: z.string().min(3, 'Describe the fault (min 3 characters)').max(5000),
  fault_code_id: z.string().optional(),
  warranty_status: z.enum(['IW', 'OW', 'GOODWILL', 'UNKNOWN']),
  assigned_engineer_id: z.string().optional(),
  so_number: z.string().max(100).optional(),
})
type FieldValues = z.infer<typeof fieldsSchema>

/**
 * Job intake (Task 1.5, DESIGN.md §6.1/§6.2, §8 item 3).
 *
 * Customer + device use find-or-create semantics matching POST /jobs
 * exactly (api/src/modules/jobs/jobs.service.ts resolveCustomer/
 * resolveDevice): search by phone/IMEI first, fall back to a nested
 * customer/device payload the API creates inline. Scalar job fields are
 * react-hook-form + zod, like the rest of the app's forms; customer/model
 * search are plain local state since they're async autocompletes with a
 * "no match → create new" branch that doesn't fit a single schema well.
 */
export function JobIntakePage() {
  const { user, can } = useAuth()

  // ---- customer search-or-create -----------------------------------------
  const [customerQuery, setCustomerQuery] = useState('')
  const debouncedCustomerQuery = useDebouncedValue(customerQuery, 350)
  const [selectedCustomer, setSelectedCustomer] = useState<CustomerWire | null>(null)
  const [newCustomerName, setNewCustomerName] = useState('')
  const [newCustomerLanguage, setNewCustomerLanguage] = useState<PreferredLanguageCode>('EN')

  const customerResults = useQuery({
    queryKey: ['customers-search', debouncedCustomerQuery],
    queryFn: async () =>
      (
        await api.get<PaginatedResponse<CustomerWire>>('/customers', {
          params: { q: debouncedCustomerQuery, page_size: 5 },
        })
      ).data.data,
    enabled: debouncedCustomerQuery.trim().length >= 2 && !selectedCustomer,
  })

  // ---- device / model autocomplete ----------------------------------------
  const [modelQuery, setModelQuery] = useState('')
  const debouncedModelQuery = useDebouncedValue(modelQuery, 300)
  const [selectedModel, setSelectedModel] = useState<ModelWire | null>(null)

  const modelResults = useQuery({
    queryKey: ['models-search', debouncedModelQuery],
    queryFn: async () =>
      (
        await api.get<PaginatedResponse<ModelWire>>('/models', {
          params: { q: debouncedModelQuery, page_size: 8, active: true },
        })
      ).data.data,
    enabled: debouncedModelQuery.trim().length >= 1 && !selectedModel,
  })

  // ---- lookups -------------------------------------------------------------
  const faultCodes = useQuery({
    queryKey: ['fault-codes', 'all'],
    queryFn: async () =>
      (
        await api.get<PaginatedResponse<FaultCodeWire>>('/fault-codes', {
          params: { page_size: 100, active: true },
        })
      ).data.data,
  })
  const branches = useQuery({
    queryKey: ['branches', 'all'],
    enabled: user?.scope === 'group' && can('config.read'),
    queryFn: async () =>
      (await api.get<PaginatedResponse<BranchWire>>('/branches', { params: { page_size: 100 } })).data
        .data,
  })
  const engineers = useQuery({
    queryKey: ['users', 'technicians'],
    enabled: can('user.read'),
    queryFn: async () =>
      (
        await api.get<PaginatedResponse<UserWire>>('/users', {
          params: { role: 'TECHNICIAN', active: true, page_size: 100 },
        })
      ).data.data,
  })

  // ---- attachments ---------------------------------------------------------
  const [beforePhotos, setBeforePhotos] = useState<File[]>([])
  const [photoPreviews, setPhotoPreviews] = useState<string[]>([])
  const sigRef = useRef<SignaturePadHandle>(null)
  const [hasSignature, setHasSignature] = useState(false)

  function onPhotosSelected(files: FileList | null) {
    if (!files) return
    const list = Array.from(files)
    setBeforePhotos((prev) => [...prev, ...list])
    setPhotoPreviews((prev) => [...prev, ...list.map((f) => URL.createObjectURL(f))])
  }
  function removePhoto(index: number) {
    setBeforePhotos((prev) => prev.filter((_, i) => i !== index))
    setPhotoPreviews((prev) => {
      const url = prev[index]
      if (url) URL.revokeObjectURL(url)
      return prev.filter((_, i) => i !== index)
    })
  }

  // ---- form ------------------------------------------------------------
  const form = useForm<FieldValues>({
    resolver: zodResolver(fieldsSchema),
    defaultValues: {
      branch_id: '',
      category: 'HHP',
      imei_serial: '',
      color: '',
      fault_reported: '',
      fault_code_id: '',
      warranty_status: 'UNKNOWN',
      assigned_engineer_id: '',
      so_number: '',
    },
  })

  const [createdJob, setCreatedJob] = useState<JobDetailWire | null>(null)
  const [attachmentWarnings, setAttachmentWarnings] = useState<string[]>([])

  // Warranty coverage lookup: as the IMEI/serial is entered, check whether the
  // unit has a registered warranty (store / manufacturer / Samsung).
  const imeiValue = form.watch('imei_serial') ?? ''
  const debouncedImei = useDebouncedValue(imeiValue.trim(), 400)
  const warranty = useQuery({
    queryKey: ['warranty-lookup', debouncedImei],
    enabled: can('customer.read') && debouncedImei.length >= 4,
    queryFn: async () =>
      (
        await api.get<WarrantyRegistrationWire | ''>(
          '/warranty-registrations/lookup',
          { params: { serial: debouncedImei } },
        )
      ).data,
  })
  const coverage =
    warranty.data && typeof warranty.data === 'object' && 'id' in warranty.data
      ? (warranty.data as WarrantyRegistrationWire)
      : null

  const createJob = useMutation({
    mutationFn: async (body: Record<string, unknown>) =>
      (await api.post<JobDetailWire>('/jobs', body)).data,
  })

  const onSubmit = form.handleSubmit(async (values) => {
    if (user?.scope === 'group' && !values.branch_id) {
      toast.error('Select a branch for this job')
      return
    }

    // The nested customer payload on POST /jobs (JobCustomerInput) only
    // accepts name/phone/alt_phone/email/location — NOT preferred_language
    // (see api/src/modules/jobs/dto/job.dto.ts). So a brand-new customer's
    // preferred language is set with a follow-up PATCH /customers/{id}
    // after the job (and the find-or-create customer) exists.
    let customerPayload: Record<string, unknown>
    let isNewCustomer = false
    if (selectedCustomer) {
      customerPayload = { customer_id: selectedCustomer.id }
    } else if (newCustomerName.trim()) {
      isNewCustomer = true
      customerPayload = {
        customer: {
          name: newCustomerName.trim(),
          phone: customerQuery.trim() || undefined,
        },
      }
    } else {
      toast.error('Search for an existing customer by phone, or enter a name to create one')
      return
    }

    const devicePayload = {
      device: {
        category: values.category,
        imei_serial: values.imei_serial?.trim() || undefined,
        model: selectedModel?.model_code ?? (modelQuery.trim() || undefined),
        model_id: selectedModel?.id,
        color: values.color?.trim() || undefined,
      },
    }

    try {
      const job = await createJob.mutateAsync({
        branch_id: values.branch_id || undefined,
        ...customerPayload,
        ...devicePayload,
        so_number: values.so_number?.trim() || undefined,
        warranty_status: values.warranty_status,
        fault_reported: values.fault_reported,
        fault_code_id: values.fault_code_id || undefined,
        assigned_engineer_id: values.assigned_engineer_id || undefined,
      })

      if (isNewCustomer) {
        try {
          await api.patch(`/customers/${job.customer.id}`, {
            preferred_language: newCustomerLanguage,
          })
        } catch {
          // Non-fatal — the job and customer are already created; the
          // language preference just stays at the API default (EN).
        }
      }

      const warnings: string[] = []
      for (const file of beforePhotos) {
        const fd = new FormData()
        fd.append('file', file)
        fd.append('owner_type', 'JOB')
        fd.append('owner_id', job.id)
        fd.append('kind', 'PHOTO_BEFORE')
        try {
          await api.post('/attachments', fd)
        } catch (e) {
          warnings.push(`Photo "${file.name}" failed to upload: ${apiErrorMessage(e)}`)
        }
      }
      if (sigRef.current && !sigRef.current.isEmpty()) {
        try {
          await api.post('/attachments/signature', {
            owner_id: job.id,
            data_uri: sigRef.current.toDataUrl(),
          })
        } catch (e) {
          warnings.push(`Signature failed to upload: ${apiErrorMessage(e)}`)
        }
      }
      setAttachmentWarnings(warnings)
      toast.success(`Job ${job.job_no} created`)
      setCreatedJob(job)
    } catch (e) {
      toast.error(apiErrorMessage(e))
    }
  })

  function resetAll() {
    setCreatedJob(null)
    setAttachmentWarnings([])
    setSelectedCustomer(null)
    setCustomerQuery('')
    setNewCustomerName('')
    setSelectedModel(null)
    setModelQuery('')
    setBeforePhotos([])
    photoPreviews.forEach((u) => URL.revokeObjectURL(u))
    setPhotoPreviews([])
    setHasSignature(false)
    sigRef.current?.clear()
    form.reset()
  }

  if (createdJob) {
    return (
      <div className="flex flex-col gap-4">
        <Card className="max-w-xl">
          <CardHeader>
            <CardTitle>Job {createdJob.job_no} created</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <p className="text-sm text-muted-foreground">
              {createdJob.customer.name} · {createdJob.device.model ?? createdJob.device.brand} ·{' '}
              {createdJob.state_label}
            </p>
            {attachmentWarnings.length > 0 && (
              <div className="rounded-md border border-destructive/30 bg-destructive/5 p-2 text-xs text-destructive">
                {attachmentWarnings.map((w) => (
                  <p key={w}>{w}</p>
                ))}
              </div>
            )}
            <div className="flex flex-wrap gap-2">
              <Button onClick={() => window.print()}>Print job ticket</Button>
              <Button variant="outline" asChild>
                <Link to={`/jobs/${createdJob.id}`}>Open job</Link>
              </Button>
              <Button variant="ghost" onClick={resetAll}>
                Create another job
              </Button>
            </div>
          </CardContent>
        </Card>

        <div className="job-ticket hidden print:block">
          <h1 className="text-lg font-bold">TriServe — Job Ticket</h1>
          <p className="font-mono text-2xl">{createdJob.job_no}</p>
          <hr className="my-2" />
          <p>Received: {formatDateTime(createdJob.received_at)}</p>
          <p>
            Customer: {createdJob.customer.name} — {createdJob.customer.phone ?? '—'}
          </p>
          <p>
            Device: {createdJob.device.brand} {createdJob.device.model ?? ''} (
            {createdJob.device.category})
          </p>
          <p>IMEI/Serial: {createdJob.device.imei_serial ?? '—'}</p>
          <p>Warranty: {createdJob.warranty_status}</p>
          <p>Fault reported: {createdJob.fault_reported ?? '—'}</p>
          <hr className="my-2" />
          <p className="text-xs">Customer signature captured at intake.</p>
        </div>
      </div>
    )
  }

  return (
    <form onSubmit={(e) => void onSubmit(e)} className="flex max-w-3xl flex-col gap-6">
      <Card>
        <CardHeader>
          <CardTitle>Customer</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {selectedCustomer ? (
            <div className="flex items-center justify-between rounded-md border p-3">
              <div>
                <p className="font-medium">{selectedCustomer.name}</p>
                <p className="text-xs text-muted-foreground">
                  {selectedCustomer.phone ?? 'no phone'} · {selectedCustomer.preferred_language}
                </p>
              </div>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setSelectedCustomer(null)}
              >
                Change
              </Button>
            </div>
          ) : (
            <>
              <FormField label="Search by phone" htmlFor="customer-search">
                <Input
                  id="customer-search"
                  placeholder="0765 111 222"
                  value={customerQuery}
                  onChange={(e) => setCustomerQuery(e.target.value)}
                />
              </FormField>
              {customerResults.data && customerResults.data.length > 0 && (
                <div className="flex flex-col gap-1 rounded-md border p-1">
                  {customerResults.data.map((c) => (
                    <button
                      key={c.id}
                      type="button"
                      className="flex flex-col items-start rounded-sm px-2 py-1.5 text-left text-sm hover:bg-muted"
                      onClick={() => setSelectedCustomer(c)}
                    >
                      <span className="font-medium">{c.name}</span>
                      <span className="text-xs text-muted-foreground">{c.phone}</span>
                    </button>
                  ))}
                </div>
              )}
              {debouncedCustomerQuery.trim().length >= 2 &&
                customerResults.data?.length === 0 && (
                  <p className="text-xs text-muted-foreground">
                    No match — create a new customer below.
                  </p>
                )}
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <FormField label="New customer name" htmlFor="new-customer-name">
                  <Input
                    id="new-customer-name"
                    placeholder="Required if not selecting an existing customer"
                    value={newCustomerName}
                    onChange={(e) => setNewCustomerName(e.target.value)}
                  />
                </FormField>
                <FormField label="Preferred language" htmlFor="new-customer-lang">
                  <Select
                    id="new-customer-lang"
                    value={newCustomerLanguage}
                    onChange={(e) =>
                      setNewCustomerLanguage(e.target.value as PreferredLanguageCode)
                    }
                  >
                    <option value="EN">English</option>
                    <option value="SW">Swahili</option>
                  </Select>
                </FormField>
              </div>
            </>
          )}
          {user?.scope === 'group' && branches.data && (
            <FormField label="Branch" htmlFor="branch_id" error={form.formState.errors.branch_id?.message}>
              <Select id="branch_id" {...form.register('branch_id')}>
                <option value="">Select branch…</option>
                {branches.data.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name} ({b.code})
                  </option>
                ))}
              </Select>
            </FormField>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Device</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <FormField label="IMEI / Serial" htmlFor="imei_serial">
            <div className="flex gap-2">
              <Input
                id="imei_serial"
                placeholder="Scan or type the IMEI/serial"
                {...form.register('imei_serial')}
              />
              <BarcodeScanButton
                onDetected={(text) => form.setValue('imei_serial', text, { shouldValidate: true })}
              />
            </div>
          </FormField>

          {coverage && (
            <div
              className={
                'flex items-start gap-3 rounded-lg border p-3 text-sm ' +
                (coverage.is_expired
                  ? 'border-amber-500/30 bg-amber-500/10'
                  : 'border-emerald-500/30 bg-emerald-500/10')
              }
            >
              <ShieldCheck
                className={
                  'mt-0.5 size-5 shrink-0 ' +
                  (coverage.is_expired
                    ? 'text-amber-600 dark:text-amber-400'
                    : 'text-emerald-600 dark:text-emerald-400')
                }
              />
              <div className="flex flex-col gap-0.5">
                <span className="font-medium">
                  {coverage.is_expired
                    ? `Warranty expired ${formatDate(coverage.expiry_date)}`
                    : `Under ${WARRANTY_KIND_LABEL[coverage.kind]} warranty · covered until ${formatDate(coverage.expiry_date)}`}
                </span>
                <span className="text-muted-foreground">
                  {coverage.product_name}
                  {coverage.brand ? ` · ${coverage.brand}` : ''}
                  {coverage.kind === 'SAMSUNG' && !coverage.is_expired
                    ? ' — this may be an in-warranty (IW) claim.'
                    : ''}
                </span>
              </div>
              {!coverage.is_expired && coverage.kind === 'SAMSUNG' && (
                <Button
                  type="button"
                  variant="outline"
                  size="xs"
                  className="ml-auto"
                  onClick={() =>
                    form.setValue('warranty_status', 'IW', { shouldValidate: true })
                  }
                >
                  Set IW
                </Button>
              )}
            </div>
          )}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <FormField label="Model" htmlFor="model-search">
              {selectedModel ? (
                <div className="flex items-center justify-between rounded-md border px-2.5 py-1">
                  <span className="text-sm">
                    {selectedModel.brand} {selectedModel.model_code}
                  </span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="xs"
                    onClick={() => setSelectedModel(null)}
                  >
                    Change
                  </Button>
                </div>
              ) : (
                <Input
                  id="model-search"
                  placeholder="e.g. A06, S23 Ultra…"
                  value={modelQuery}
                  onChange={(e) => setModelQuery(e.target.value)}
                />
              )}
              {!selectedModel && modelResults.data && modelResults.data.length > 0 && (
                <div className="mt-1 flex flex-col gap-0.5 rounded-md border p-1">
                  {modelResults.data.map((m) => (
                    <button
                      key={m.id}
                      type="button"
                      className="rounded-sm px-2 py-1 text-left text-sm hover:bg-muted"
                      onClick={() => setSelectedModel(m)}
                    >
                      {m.brand} {m.model_code}
                    </button>
                  ))}
                </div>
              )}
            </FormField>
            <FormField label="Category" htmlFor="category">
              <Select id="category" {...form.register('category')}>
                {CATEGORIES.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </Select>
            </FormField>
          </div>
          <FormField label="Colour" htmlFor="color">
            <Input id="color" placeholder="e.g. Black" {...form.register('color')} />
          </FormField>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Job details</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <FormField
            label="Fault reported"
            htmlFor="fault_reported"
            error={form.formState.errors.fault_reported?.message}
          >
            <Textarea
              id="fault_reported"
              rows={3}
              placeholder="What the customer says is wrong…"
              {...form.register('fault_reported')}
            />
          </FormField>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {faultCodes.data && (
              <FormField label="Fault code (optional)" htmlFor="fault_code_id">
                <Select id="fault_code_id" {...form.register('fault_code_id')}>
                  <option value="">—</option>
                  {faultCodes.data.map((fc) => (
                    <option key={fc.id} value={fc.id}>
                      {fc.label}
                    </option>
                  ))}
                </Select>
              </FormField>
            )}
            <FormField label="Warranty status" htmlFor="warranty_status">
              <Select id="warranty_status" {...form.register('warranty_status')}>
                {WARRANTY_STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </Select>
            </FormField>
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {can('user.read') ? (
              <FormField label="Assign engineer (optional)" htmlFor="assigned_engineer_id">
                <Select id="assigned_engineer_id" {...form.register('assigned_engineer_id')}>
                  <option value="">Unassigned</option>
                  {engineers.data?.map((e) => (
                    <option key={e.id} value={e.id}>
                      {e.full_name}
                    </option>
                  ))}
                </Select>
              </FormField>
            ) : (
              <div className="flex items-end pb-1.5 text-xs text-muted-foreground">
                Engineer assignment is done by a manager after intake.
              </div>
            )}
            <FormField label="Samsung SO number (optional)" htmlFor="so_number">
              <Input id="so_number" {...form.register('so_number')} />
            </FormField>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Before-photos &amp; signature</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <FormField label="Before-photos" htmlFor="before-photos">
            <Input
              id="before-photos"
              type="file"
              accept="image/*"
              multiple
              onChange={(e) => onPhotosSelected(e.target.files)}
            />
            {photoPreviews.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-2">
                {photoPreviews.map((src, i) => (
                  <div key={src} className="relative">
                    <img src={src} alt="" className="size-20 rounded-md border object-cover" />
                    <button
                      type="button"
                      className="absolute -right-1.5 -top-1.5 rounded-full bg-destructive px-1.5 text-xs text-destructive-foreground"
                      onClick={() => removePhoto(i)}
                    >
                      ×
                    </button>
                  </div>
                ))}
              </div>
            )}
          </FormField>
          <FormField label="Customer signature" htmlFor="signature">
            <div className="flex flex-col items-start gap-2">
              <SignaturePad ref={sigRef} onChange={setHasSignature} />
              <div className="flex items-center gap-2">
                <Button type="button" variant="outline" size="sm" onClick={() => sigRef.current?.clear()}>
                  Clear
                </Button>
                {hasSignature && <Badge variant="success">Captured</Badge>}
              </div>
            </div>
          </FormField>
        </CardContent>
      </Card>

      <div className="flex gap-2">
        <Button type="submit" disabled={createJob.isPending}>
          {createJob.isPending ? 'Creating job…' : 'Create job'}
        </Button>
      </div>
    </form>
  )
}
