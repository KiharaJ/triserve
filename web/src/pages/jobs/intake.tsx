import { zodResolver } from '@hookform/resolvers/zod'
import { useMutation, useQuery } from '@tanstack/react-query'
import {
  Camera,
  Check,
  ChevronLeft,
  ChevronRight,
  ClipboardList,
  FileText,
  ShieldCheck,
  Smartphone,
  User,
  type LucideIcon,
} from 'lucide-react'
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
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { api, apiErrorMessage } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { formatDate, formatDateTime } from '@/lib/format'
import { useDebouncedValue } from '@/lib/use-debounced-value'
import { cn } from '@/lib/utils'
import {
  CUSTOMER_TYPES,
  JOB_COVERAGES,
  SERVICE_TYPES,
  coverageLabel,
  defaultCoverageFor,
  serviceTypeLabel,
  type BranchWire,
  type CustomerType,
  type CustomerWire,
  type DeviceCategory,
  type FaultCodeWire,
  type JobDetailWire,
  type ModelWire,
  type ParsedJobCard,
  type PreferredLanguageCode,
  JOB_PRIORITIES,
  type ServiceCategoryWire,
  type ServiceCodeWire,
  type UserWire,
  type WarrantyRegistrationWire,
  type WarrantyStatus,
} from '@/lib/types'

const CATEGORIES: DeviceCategory[] = ['HHP', 'CE', 'AC', 'REF', 'OTHER']
const WARRANTY_STATUSES: WarrantyStatus[] = ['IW', 'OW', 'GOODWILL', 'UNKNOWN']
const WARRANTY_KIND_LABEL: Record<string, string> = {
  STORE: 'store',
  MANUFACTURER: 'manufacturer',
  SAMSUNG: 'Samsung',
}

/**
 * Intake runs as a guided wizard rather than one long scroll: the front desk
 * takes a device in as a conversation — who, what, what's wrong, who pays —
 * so the form follows that order one step at a time. Each step shows only its
 * own fields, a progress rail marks where you are, and a live summary on the
 * right keeps the whole picture visible. The job is created only on the last
 * step's Create button; Next just advances.
 */
const STEPS: { key: string; title: string; icon: LucideIcon }[] = [
  { key: 'customer', title: 'Customer', icon: User },
  { key: 'device', title: 'Device', icon: Smartphone },
  { key: 'job', title: 'Job', icon: ClipboardList },
  { key: 'warranty', title: 'Warranty', icon: ShieldCheck },
  { key: 'finish', title: 'Finish', icon: Camera },
]
const LAST_STEP = STEPS.length - 1
/** Which step owns each schema-validated field, so a submit error jumps there. */
const FIELD_STEP: Record<string, number> = { fault_reported: 2, branch_id: 0 }

const fieldsSchema = z.object({
  branch_id: z.string().optional(),
  category: z.enum(['HHP', 'CE', 'AC', 'REF', 'OTHER']),
  service_category_id: z.string().optional(),
  priority: z.enum(['LOW', 'NORMAL', 'HIGH', 'URGENT']),
  imei_serial: z.string().max(100).optional(),
  color: z.string().max(50).optional(),
  purchase_date: z.string().optional(),
  fault_reported: z.string().min(3, 'Describe the fault (min 3 characters)').max(5000),
  fault_code_id: z.string().optional(),
  symptom_code_id: z.string().optional(),
  warranty_status: z.enum(['IW', 'OW', 'GOODWILL', 'UNKNOWN']),
  coverage: z.enum(['FULL', 'LABOUR_ONLY', 'PARTS_ONLY', 'NONE']),
  service_type: z.enum([
    'CARRY_IN',
    'PICKUP',
    'IN_HOME',
    'INITIAL_INSTALL',
    'INSPECTION',
    'INSURANCE',
    'PRODUCT_RETURN',
    'RETURN_HANDLING',
    'STOCK_REPAIR',
    'ADH',
  ]),
  accessories_held: z.string().max(500).optional(),
  return_by_date: z.string().optional(),
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
  const [newCustomerAltPhone, setNewCustomerAltPhone] = useState('')
  const [newCustomerEmail, setNewCustomerEmail] = useState('')
  const [newCustomerLocation, setNewCustomerLocation] = useState('')
  const [newCustomerType, setNewCustomerType] = useState<CustomerType>('INDIVIDUAL')
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
  // The customer-reported symptom is the ONE GSPN code knowable at the
  // counter; condition/defect/defect-type/block/repair are diagnosis outputs
  // and belong on the job detail page, not intake. Served by /active so a
  // front-desk user without config.read can still populate the picker.
  // What the customer is asking for. Served by /active so the front desk can
  // populate it without holding config.read.
  const serviceCategories = useQuery({
    queryKey: ['service-categories', 'active'],
    queryFn: async () =>
      (
        await api.get<PaginatedResponse<ServiceCategoryWire>>(
          '/service-categories/active',
        )
      ).data.data,
  })
  const symptomCodes = useQuery({
    queryKey: ['service-codes', 'SYMPTOM'],
    queryFn: async () =>
      (
        await api.get<PaginatedResponse<ServiceCodeWire>>('/service-codes/active', {
          params: { kind: 'SYMPTOM' },
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
      service_category_id: '',
      priority: 'NORMAL',
      imei_serial: '',
      color: '',
      purchase_date: '',
      fault_reported: '',
      fault_code_id: '',
      symptom_code_id: '',
      warranty_status: 'UNKNOWN',
      // UNKNOWN means "not ruled yet", and until someone rules it the customer
      // is presumed to be paying — same conservative default as the API.
      coverage: 'NONE',
      service_type: 'CARRY_IN',
      accessories_held: '',
      return_by_date: '',
      assigned_engineer_id: '',
      so_number: '',
    },
  })

  const [createdJob, setCreatedJob] = useState<JobDetailWire | null>(null)
  const [attachmentWarnings, setAttachmentWarnings] = useState<string[]>([])

  // ---- wizard navigation ---------------------------------------------------
  const [step, setStep] = useState(0)
  // The furthest step reached via a valid Next, so the stepper header lets the
  // user jump back and forth among sections they have already completed.
  const [maxReached, setMaxReached] = useState(0)
  // Slide direction, so the content animates in from the side you're heading.
  const [dir, setDir] = useState<1 | -1>(1)

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
  const registration =
    warranty.data && typeof warranty.data === 'object' && 'id' in warranty.data
      ? (warranty.data as WarrantyRegistrationWire)
      : null

  // Set only when the ruling was JUSTIFIED by the registration above — it is
  // what makes `warranty_source` REGISTRATION rather than MANUAL, so it must
  // not survive a later manual override of the warranty fields.
  const [appliedRegistrationId, setAppliedRegistrationId] = useState<string | null>(null)

  const warrantyStatusValue = form.watch('warranty_status')
  const coverageValue = form.watch('coverage')

  /**
   * Rule the job from the matched registration: IW + full cover, and remember
   * WHICH registration said so. A live Samsung registration is the strongest
   * evidence available at the counter.
   */
  function applyRegistration(reg: WarrantyRegistrationWire) {
    form.setValue('warranty_status', 'IW', { shouldValidate: true })
    form.setValue('coverage', 'FULL', { shouldValidate: true })
    setAppliedRegistrationId(reg.id)
  }

  const createJob = useMutation({
    mutationFn: async (body: Record<string, unknown>) =>
      (await api.post<JobDetailWire>('/jobs', body)).data,
  })

  // ---- GSPN job-card PDF import -------------------------------------------
  const [importWarnings, setImportWarnings] = useState<string[]>([])

  /**
   * Prefill the form from a Samsung job-card PDF. The API only PARSES — the
   * job is still created by submitting this form, so everything below is a
   * suggestion the advisor reviews. Coverage is never prefilled (the PDF
   * cannot express which warranty box is ticked).
   */
  const importJobCard = useMutation({
    mutationFn: async (file: File) => {
      const fd = new FormData()
      fd.append('file', file)
      return (await api.post<ParsedJobCard>('/jobs/import/gspn-jobcard', fd)).data
    },
    onSuccess: (draft) => {
      if (draft.so_number) form.setValue('so_number', draft.so_number)
      // The card's serial is complete; its IMEI is masked, so the serial is
      // what can actually match a device or a warranty registration.
      if (draft.serial) {
        form.setValue('imei_serial', draft.serial, { shouldValidate: true })
      }
      if (draft.purchase_date) form.setValue('purchase_date', draft.purchase_date)
      if (draft.service_type) form.setValue('service_type', draft.service_type)
      if (draft.accessories_held) form.setValue('accessories_held', draft.accessories_held)
      if (draft.fault_reported) {
        form.setValue('fault_reported', draft.fault_reported, { shouldValidate: true })
      }
      if (draft.model) setModelQuery(draft.model)
      // Customer: fill the new-customer branch only. An already-selected
      // customer is a deliberate choice by the advisor — don't undo it.
      if (!selectedCustomer) {
        if (draft.phone) setCustomerQuery(draft.phone)
        if (draft.customer_name) setNewCustomerName(draft.customer_name)
        if (draft.address) setNewCustomerLocation(draft.address)
      }
      setImportWarnings(draft.warnings)
      // Everything is filled but unverified — start at the top so the advisor
      // steps through and confirms each section, especially the warranty.
      setStep(0)
      setMaxReached(LAST_STEP)
      toast.success('Job card read — step through and check the details')
    },
    onError: (e) => toast.error(apiErrorMessage(e)),
  })

  const onSubmit = form.handleSubmit(
    async (values) => {
      if (user?.scope === 'group' && !values.branch_id) {
        setStep(0)
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
            alt_phone: newCustomerAltPhone.trim() || undefined,
            email: newCustomerEmail.trim() || undefined,
            location: newCustomerLocation.trim() || undefined,
            type: newCustomerType,
          },
        }
      } else {
        setStep(0)
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
          purchase_date: values.purchase_date || undefined,
        },
      }

      // Only claim REGISTRATION as the source if the ruling still matches what
      // the registration set — an advisor who then changed the warranty by hand
      // made a MANUAL call, and the audit trail should say so.
      const ruledFromRegistration =
        appliedRegistrationId !== null &&
        values.warranty_status === 'IW' &&
        values.coverage === 'FULL'

      try {
        const job = await createJob.mutateAsync({
          branch_id: values.branch_id || undefined,
          ...customerPayload,
          ...devicePayload,
          so_number: values.so_number?.trim() || undefined,
          warranty_status: values.warranty_status,
          coverage: values.coverage,
          service_type: values.service_type,
          service_category_id: values.service_category_id || undefined,
          priority: values.priority,
          warranty_source: ruledFromRegistration ? 'REGISTRATION' : undefined,
          warranty_registration_id: ruledFromRegistration
            ? appliedRegistrationId
            : undefined,
          fault_reported: values.fault_reported,
          fault_code_id: values.fault_code_id || undefined,
          symptom_code_id: values.symptom_code_id || undefined,
          accessories_held: values.accessories_held?.trim() || undefined,
          return_by_date: values.return_by_date || undefined,
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
    },
    // The only schema-required field lives on the Job step — if Create is
    // pressed with it empty, jump there rather than failing on a hidden field.
    (errors) => {
      const first = Object.keys(errors)[0]
      setStep(FIELD_STEP[first] ?? 2)
      toast.error('Some details are missing — check the highlighted step')
    },
  )

  /** Validate the CURRENT step before letting Next advance past it. */
  async function validateStep(i: number): Promise<boolean> {
    if (i === 0) {
      if (user?.scope === 'group' && !form.getValues('branch_id')) {
        await form.trigger('branch_id')
        toast.error('Select a branch for this job')
        return false
      }
      if (!selectedCustomer && !newCustomerName.trim()) {
        toast.error('Search for a customer by phone, or enter a name to create one')
        return false
      }
      return true
    }
    if (i === 2) return form.trigger('fault_reported')
    return true
  }

  async function goNext() {
    if (!(await validateStep(step))) return
    setDir(1)
    setMaxReached((m) => Math.max(m, step + 1))
    setStep((s) => Math.min(s + 1, LAST_STEP))
  }
  function goBack() {
    setDir(-1)
    setStep((s) => Math.max(s - 1, 0))
  }
  function goTo(i: number) {
    if (i > maxReached) return
    setDir(i > step ? 1 : -1)
    setStep(i)
  }

  /**
   * Enter advances the wizard instead of submitting — a form's implicit submit
   * on Enter would create the job from step 1. Textareas keep Enter for
   * newlines, and on the last step Enter falls through to the real submit.
   */
  function onFormKeyDown(e: React.KeyboardEvent<HTMLFormElement>) {
    if (e.key !== 'Enter') return
    const el = e.target as HTMLElement
    if (el.tagName === 'TEXTAREA') return
    if (step !== LAST_STEP) {
      e.preventDefault()
      void goNext()
    }
  }

  function resetAll() {
    setCreatedJob(null)
    setAttachmentWarnings([])
    setSelectedCustomer(null)
    setCustomerQuery('')
    setNewCustomerName('')
    setNewCustomerAltPhone('')
    setNewCustomerEmail('')
    setNewCustomerLocation('')
    setNewCustomerType('INDIVIDUAL')
    setNewCustomerLanguage('EN')
    setSelectedModel(null)
    setModelQuery('')
    setAppliedRegistrationId(null)
    setImportWarnings([])
    setBeforePhotos([])
    photoPreviews.forEach((u) => URL.revokeObjectURL(u))
    setPhotoPreviews([])
    setHasSignature(false)
    sigRef.current?.clear()
    setStep(0)
    setMaxReached(0)
    form.reset()
  }

  if (createdJob) {
    return (
      <div className="flex flex-col gap-4">
        <Card className="max-w-xl">
          <CardContent className="flex flex-col gap-3 py-5">
            <div className="flex items-center gap-2">
              <span className="flex size-8 items-center justify-center rounded-full bg-emerald-500/15 text-emerald-600 dark:text-emerald-400">
                <Check className="size-5" />
              </span>
              <span className="text-lg font-semibold">Job {createdJob.job_no} created</span>
            </div>
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
          <p>Service type: {serviceTypeLabel(createdJob.service_type)}</p>
          <p>
            Warranty: {createdJob.warranty_status} — {coverageLabel(createdJob.coverage)}
          </p>
          {/* T&C 2 makes accessories a custody liability — they must appear on
              the customer's copy, not just in the database. */}
          <p>Accessories held: {createdJob.accessories_held ?? '—'}</p>
          <p>Fault reported: {createdJob.fault_reported ?? '—'}</p>
          {createdJob.return_by_date && <p>Return by: {formatDate(createdJob.return_by_date)}</p>}
          <hr className="my-2" />
          <p className="text-xs">Customer signature captured at intake.</p>
        </div>
      </div>
    )
  }

  // ---- live summary values (right rail) -----------------------------------
  const v = form.watch()
  const summaryCustomer = selectedCustomer?.name ?? (newCustomerName.trim() || null)
  const summaryPhone = selectedCustomer?.phone ?? (customerQuery.trim() || null)
  const summaryModel = selectedModel?.model_code ?? (modelQuery.trim() || null)
  const summaryLine =
    serviceCategories.data?.find((c) => c.id === v.service_category_id)?.label ?? null

  return (
    <div className="flex max-w-4xl flex-col gap-4">
      {/* Quick start: read a Samsung job card and prefill every step. */}
      <div className="flex flex-col gap-2 rounded-xl border bg-muted/30 p-3 sm:flex-row sm:items-center">
        <FileText className="hidden size-5 shrink-0 text-muted-foreground sm:block" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium">Start from a Samsung job card</p>
          <p className="text-xs text-muted-foreground">
            Optional — reads a GSPN Service Order Sheet (PDF) and fills the steps in.
          </p>
        </div>
        <div className="flex flex-col gap-1">
          <Button asChild variant="outline" size="sm" disabled={importJobCard.isPending}>
            <label className="cursor-pointer">
              {importJobCard.isPending ? 'Reading…' : 'Upload PDF'}
              <input
                type="file"
                accept="application/pdf"
                className="hidden"
                onChange={(e) => {
                  const file = e.target.files?.[0]
                  if (file) importJobCard.mutate(file)
                  e.target.value = ''
                }}
              />
            </label>
          </Button>
        </div>
      </div>
      {importWarnings.length > 0 && (
        <div className="rounded-md border border-amber-500/30 bg-amber-500/10 p-2 text-xs">
          {importWarnings.map((w) => (
            <p key={w}>{w}</p>
          ))}
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_240px]">
        <form onSubmit={(e) => void onSubmit(e)} onKeyDown={onFormKeyDown}>
          <Card className="overflow-hidden">
            {/* Stepper header: numbered circles + connectors that fill as you go. */}
            <div className="border-b px-4 py-4 sm:px-6">
              <div className="flex items-center">
                {STEPS.map((s, i) => {
                  const done = i < step
                  const current = i === step
                  const reachable = i <= maxReached
                  const Icon = s.icon
                  return (
                    <div key={s.key} className="flex items-center last:flex-none [&:not(:last-child)]:flex-1">
                      <button
                        type="button"
                        onClick={() => goTo(i)}
                        disabled={!reachable}
                        className={cn(
                          'flex items-center gap-2',
                          reachable ? 'cursor-pointer' : 'cursor-default',
                        )}
                      >
                        <span
                          className={cn(
                            'flex size-8 shrink-0 items-center justify-center rounded-full border text-sm font-semibold transition-colors',
                            done
                              ? 'border-primary bg-primary text-primary-foreground'
                              : current
                                ? 'border-primary text-primary'
                                : 'border-muted-foreground/30 text-muted-foreground',
                          )}
                        >
                          {done ? <Check className="size-4" /> : <Icon className="size-4" />}
                        </span>
                        <span
                          className={cn(
                            'hidden text-sm font-medium sm:inline',
                            current ? 'text-foreground' : 'text-muted-foreground',
                          )}
                        >
                          {s.title}
                        </span>
                      </button>
                      {i < LAST_STEP && (
                        <div className="mx-2 h-0.5 flex-1 overflow-hidden rounded-full bg-muted">
                          <div
                            className={cn(
                              'h-full rounded-full bg-primary transition-all duration-500',
                              done ? 'w-full' : 'w-0',
                            )}
                          />
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            </div>

            <CardContent className="px-4 py-5 sm:px-6">
              <div
                key={step}
                className={cn(
                  'flex flex-col gap-3 duration-300 animate-in fade-in',
                  dir === 1 ? 'slide-in-from-right-6' : 'slide-in-from-left-6',
                )}
              >
                {step === 0 && (
                  <>
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
                          <FormField label="Type" htmlFor="new-customer-type">
                            <Select
                              id="new-customer-type"
                              value={newCustomerType}
                              onChange={(e) => setNewCustomerType(e.target.value as CustomerType)}
                            >
                              {CUSTOMER_TYPES.map((t) => (
                                <option key={t.value} value={t.value}>
                                  {t.label}
                                </option>
                              ))}
                            </Select>
                          </FormField>
                          <FormField label="Alternate phone" htmlFor="new-customer-altphone">
                            <Input
                              id="new-customer-altphone"
                              value={newCustomerAltPhone}
                              onChange={(e) => setNewCustomerAltPhone(e.target.value)}
                            />
                          </FormField>
                          <FormField label="Email" htmlFor="new-customer-email">
                            <Input
                              id="new-customer-email"
                              type="email"
                              value={newCustomerEmail}
                              onChange={(e) => setNewCustomerEmail(e.target.value)}
                            />
                          </FormField>
                          <FormField label="Location" htmlFor="new-customer-location">
                            <Input
                              id="new-customer-location"
                              value={newCustomerLocation}
                              onChange={(e) => setNewCustomerLocation(e.target.value)}
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
                      <FormField
                        label="Branch"
                        htmlFor="branch_id"
                        error={form.formState.errors.branch_id?.message}
                      >
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
                  </>
                )}

                {step === 1 && (
                  <>
                    <FormField label="IMEI / Serial" htmlFor="imei_serial">
                      <div className="flex gap-2">
                        <Input
                          id="imei_serial"
                          placeholder="Scan or type the IMEI/serial"
                          {...form.register('imei_serial')}
                        />
                        <BarcodeScanButton
                          onDetected={(text) =>
                            form.setValue('imei_serial', text, { shouldValidate: true })
                          }
                        />
                      </div>
                    </FormField>

                    {registration && (
                      <div
                        className={
                          'flex items-start gap-3 rounded-lg border p-3 text-sm ' +
                          (registration.is_expired
                            ? 'border-amber-500/30 bg-amber-500/10'
                            : 'border-emerald-500/30 bg-emerald-500/10')
                        }
                      >
                        <ShieldCheck
                          className={
                            'mt-0.5 size-5 shrink-0 ' +
                            (registration.is_expired
                              ? 'text-amber-600 dark:text-amber-400'
                              : 'text-emerald-600 dark:text-emerald-400')
                          }
                        />
                        <div className="flex flex-col gap-0.5">
                          <span className="font-medium">
                            {registration.is_expired
                              ? `Warranty expired ${formatDate(registration.expiry_date)}`
                              : `Under ${WARRANTY_KIND_LABEL[registration.kind]} warranty · covered until ${formatDate(registration.expiry_date)}`}
                          </span>
                          <span className="text-muted-foreground">
                            {registration.product_name}
                            {registration.brand ? ` · ${registration.brand}` : ''}
                            {registration.kind === 'SAMSUNG' && !registration.is_expired
                              ? ' — this may be an in-warranty (IW) claim.'
                              : ''}
                          </span>
                        </div>
                        {!registration.is_expired &&
                          (appliedRegistrationId === registration.id ? (
                            <Badge variant="success" className="ml-auto shrink-0">
                              Applied
                            </Badge>
                          ) : (
                            <Button
                              type="button"
                              variant="outline"
                              size="xs"
                              className="ml-auto shrink-0"
                              onClick={() => applyRegistration(registration)}
                            >
                              Apply IW cover
                            </Button>
                          ))}
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
                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                      <FormField label="Colour" htmlFor="color">
                        <Input id="color" placeholder="e.g. Black" {...form.register('color')} />
                      </FormField>
                      <FormField
                        label="Purchase date"
                        htmlFor="purchase_date"
                        hint="From the receipt — decides warranty when no registration matches."
                      >
                        <Input id="purchase_date" type="date" {...form.register('purchase_date')} />
                      </FormField>
                    </div>
                  </>
                )}

                {step === 2 && (
                  <>
                    {/* What the customer wants, and how urgently — the two fields
                        that make triage and per-line reporting possible. */}
                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                      <FormField
                        label="Service needed"
                        htmlFor="service_category_id"
                        hint="What the customer is asking for. Sets the turnaround target."
                      >
                        <Select id="service_category_id" {...form.register('service_category_id')}>
                          <option value="">—</option>
                          {serviceCategories.data?.map((c) => (
                            <option key={c.id} value={c.id}>
                              {c.label}
                              {c.default_sla_hours ? ` (${c.default_sla_hours}h)` : ''}
                            </option>
                          ))}
                        </Select>
                      </FormField>
                      <FormField label="Priority" htmlFor="priority">
                        <Select id="priority" {...form.register('priority')}>
                          {JOB_PRIORITIES.map((p) => (
                            <option key={p.value} value={p.value}>
                              {p.label}
                            </option>
                          ))}
                        </Select>
                      </FormField>
                    </div>
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
                      {symptomCodes.data && symptomCodes.data.length > 0 && (
                        <FormField
                          label="Customer symptom (GSPN)"
                          htmlFor="symptom_code_id"
                          hint="Diagnosis codes are set by the engineer during repair."
                        >
                          <Select id="symptom_code_id" {...form.register('symptom_code_id')}>
                            <option value="">—</option>
                            {symptomCodes.data.map((sc) => (
                              <option key={sc.id} value={sc.id}>
                                {sc.code} — {sc.label}
                              </option>
                            ))}
                          </Select>
                        </FormField>
                      )}
                      <FormField label="Service type" htmlFor="service_type">
                        <Select id="service_type" {...form.register('service_type')}>
                          {SERVICE_TYPES.map((t) => (
                            <option key={t.value} value={t.value}>
                              {t.label}
                            </option>
                          ))}
                        </Select>
                      </FormField>
                      <FormField
                        label="Accessories held"
                        htmlFor="accessories_held"
                        hint="Anything kept with the device — SIM tray, case, charger."
                      >
                        <Input
                          id="accessories_held"
                          placeholder="e.g. SIM TRAY"
                          {...form.register('accessories_held')}
                        />
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
                  </>
                )}

                {step === 3 && (
                  <>
                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                      <FormField label="Warranty status" htmlFor="warranty_status">
                        <Select
                          id="warranty_status"
                          {...form.register('warranty_status', {
                            // Coverage follows the status by default; an advisor
                            // can still override it below for the labour-only /
                            // parts-only cases the Samsung job card allows.
                            onChange: (e: React.ChangeEvent<HTMLSelectElement>) => {
                              const next = e.target.value as WarrantyStatus
                              form.setValue('coverage', defaultCoverageFor(next), {
                                shouldValidate: true,
                              })
                              setAppliedRegistrationId(null)
                            },
                          })}
                        >
                          {WARRANTY_STATUSES.map((s) => (
                            <option key={s} value={s}>
                              {s}
                            </option>
                          ))}
                        </Select>
                      </FormField>
                      <FormField label="Who pays" htmlFor="coverage">
                        <Select id="coverage" {...form.register('coverage')}>
                          {JOB_COVERAGES.map((c) => (
                            <option key={c.value} value={c.value}>
                              {c.label}
                            </option>
                          ))}
                        </Select>
                      </FormField>
                    </div>

                    {coverageValue !== 'FULL' && (
                      <p className="rounded-md border border-amber-500/30 bg-amber-500/10 p-2 text-xs">
                        The customer pays for this repair
                        {coverageValue === 'LABOUR_ONLY'
                          ? ' (parts)'
                          : coverageValue === 'PARTS_ONLY'
                            ? ' (labour)'
                            : ''}
                        . A quote must be raised and accepted before work starts — repair is
                        blocked until then.
                      </p>
                    )}
                    {warrantyStatusValue === 'UNKNOWN' && (
                      <p className="text-xs text-muted-foreground">
                        Warranty not ruled yet. Left as-is, this job is treated as chargeable
                        until someone decides.
                      </p>
                    )}
                    {appliedRegistrationId && (
                      <p className="text-xs text-muted-foreground">
                        Ruled from the matched warranty registration — recorded as the evidence
                        for this decision.
                      </p>
                    )}

                    <FormField
                      label="Return by"
                      htmlFor="return_by_date"
                      hint="Promised collection date shown to the customer."
                      className="sm:max-w-[50%]"
                    >
                      <Input id="return_by_date" type="date" {...form.register('return_by_date')} />
                    </FormField>
                  </>
                )}

                {step === 4 && (
                  <>
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
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            onClick={() => sigRef.current?.clear()}
                          >
                            Clear
                          </Button>
                          {hasSignature && <Badge variant="success">Captured</Badge>}
                        </div>
                      </div>
                    </FormField>
                    <p className="text-xs text-muted-foreground">
                      Photos and signature are optional. Press Create to open the job.
                    </p>
                  </>
                )}
              </div>
            </CardContent>

            {/* Footer nav — Next only advances; Create (last step) submits. */}
            <div className="flex items-center justify-between gap-2 border-t px-4 py-3 sm:px-6">
              <Button type="button" variant="ghost" onClick={goBack} disabled={step === 0}>
                <ChevronLeft className="size-4" /> Back
              </Button>
              <span className="text-xs text-muted-foreground">
                Step {step + 1} of {STEPS.length}
              </span>
              {step < LAST_STEP ? (
                <Button type="button" onClick={() => void goNext()}>
                  Next <ChevronRight className="size-4" />
                </Button>
              ) : (
                <Button type="submit" disabled={createJob.isPending}>
                  {createJob.isPending ? 'Creating job…' : 'Create job'}
                </Button>
              )}
            </div>
          </Card>
        </form>

        {/* Live summary — the whole picture while you work one step at a time. */}
        <aside className="hidden lg:block">
          <div className="sticky top-4 flex flex-col gap-3 rounded-xl border bg-card p-4 text-sm">
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Summary
            </p>
            <SummaryRow label="Customer" value={summaryCustomer} sub={summaryPhone} />
            <SummaryRow
              label="Device"
              value={summaryModel ?? v.category}
              sub={v.imei_serial?.trim() || null}
            />
            <SummaryRow
              label="Service"
              value={summaryLine}
              sub={v.priority !== 'NORMAL' ? `${v.priority} priority` : null}
            />
            <SummaryRow
              label="Who pays"
              value={coverageLabel(v.coverage)}
              sub={v.warranty_status !== 'UNKNOWN' ? v.warranty_status : 'not ruled'}
            />
            <SummaryRow
              label="Attachments"
              value={
                beforePhotos.length > 0 || hasSignature
                  ? [
                      beforePhotos.length ? `${beforePhotos.length} photo(s)` : null,
                      hasSignature ? 'signed' : null,
                    ]
                      .filter(Boolean)
                      .join(' · ')
                  : null
              }
            />
          </div>
        </aside>
      </div>
    </div>
  )
}

/** One line of the summary rail; dims to a placeholder until filled. */
function SummaryRow({
  label,
  value,
  sub,
}: {
  label: string
  value: string | null | undefined
  sub?: string | null
}) {
  return (
    <div className="flex flex-col gap-0.5 border-t pt-2 first-of-type:border-t-0 first-of-type:pt-0">
      <span className="text-xs text-muted-foreground">{label}</span>
      {value ? (
        <>
          <span className="font-medium">{value}</span>
          {sub && <span className="text-xs text-muted-foreground">{sub}</span>}
        </>
      ) : (
        <span className="text-muted-foreground">—</span>
      )}
    </div>
  )
}
