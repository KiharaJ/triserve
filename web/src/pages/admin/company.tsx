import { zodResolver } from '@hookform/resolvers/zod'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect } from 'react'
import { useForm } from 'react-hook-form'
import { toast } from 'sonner'
import { z } from 'zod'
import { FormField } from '@/components/shared/form-field'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { api, apiErrorMessage } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import type { CompanyWire } from '@/lib/types'

const companySchema = z.object({
  name: z.string().min(2, 'At least 2 characters').max(255),
  legal_name: z.string().max(255),
  tin: z.string().max(50),
  vrn: z.string().max(50),
  address: z.string().max(500),
  phone: z.string().max(50),
})

type CompanyForm = z.infer<typeof companySchema>

/** Company profile (Task 0.7): view + edit — edit is SUPER_ADMIN only. */
export function CompanyPage() {
  const { can } = useAuth()
  const queryClient = useQueryClient()
  const canManage = can('config.manage')

  const company = useQuery({
    queryKey: ['company'],
    queryFn: async () => (await api.get<CompanyWire>('/company')).data,
  })

  const form = useForm<CompanyForm>({
    resolver: zodResolver(companySchema),
    defaultValues: {
      name: '',
      legal_name: '',
      tin: '',
      vrn: '',
      address: '',
      phone: '',
    },
  })

  useEffect(() => {
    if (company.data) {
      form.reset({
        name: company.data.name,
        legal_name: company.data.legal_name ?? '',
        tin: company.data.tin ?? '',
        vrn: company.data.vrn ?? '',
        address: company.data.address ?? '',
        phone: company.data.phone ?? '',
      })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [company.data])

  const save = useMutation({
    mutationFn: async (values: CompanyForm) =>
      (await api.patch<CompanyWire>('/company', values)).data,
    onSuccess: async () => {
      toast.success('Company profile updated')
      await queryClient.invalidateQueries({ queryKey: ['company'] })
    },
    onError: (e) => toast.error(apiErrorMessage(e)),
  })

  const submit = form.handleSubmit((values) => save.mutate(values))

  if (company.isPending) {
    return <p className="text-sm text-muted-foreground">Loading…</p>
  }
  if (company.isError) {
    return (
      <p className="text-sm text-destructive">
        {apiErrorMessage(company.error)}
      </p>
    )
  }

  return (
    <Card className="max-w-2xl">
      <CardHeader>
        <CardTitle>Company profile</CardTitle>
        <CardDescription>
          Base currency: {company.data.base_currency} (fixed — changing the
          base currency of a live ledger is an accounting migration).
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <FormField
              label="Name"
              htmlFor="company-name"
              error={form.formState.errors.name?.message}
            >
              <Input
                id="company-name"
                disabled={!canManage}
                {...form.register('name')}
              />
            </FormField>
            <FormField
              label="Legal name"
              htmlFor="company-legal"
              error={form.formState.errors.legal_name?.message}
            >
              <Input
                id="company-legal"
                disabled={!canManage}
                {...form.register('legal_name')}
              />
            </FormField>
            <FormField
              label="TIN"
              htmlFor="company-tin"
              error={form.formState.errors.tin?.message}
            >
              <Input
                id="company-tin"
                disabled={!canManage}
                {...form.register('tin')}
              />
            </FormField>
            <FormField
              label="VRN"
              htmlFor="company-vrn"
              error={form.formState.errors.vrn?.message}
            >
              <Input
                id="company-vrn"
                disabled={!canManage}
                {...form.register('vrn')}
              />
            </FormField>
            <FormField
              label="Phone"
              htmlFor="company-phone"
              error={form.formState.errors.phone?.message}
            >
              <Input
                id="company-phone"
                disabled={!canManage}
                {...form.register('phone')}
              />
            </FormField>
            <FormField
              label="Address"
              htmlFor="company-address"
              error={form.formState.errors.address?.message}
            >
              <Input
                id="company-address"
                disabled={!canManage}
                {...form.register('address')}
              />
            </FormField>
          </div>
          {canManage && (
            <Button
              type="submit"
              className="w-fit"
              disabled={save.isPending}
            >
              {save.isPending ? 'Saving…' : 'Save changes'}
            </Button>
          )}
        </form>
      </CardContent>
    </Card>
  )
}
