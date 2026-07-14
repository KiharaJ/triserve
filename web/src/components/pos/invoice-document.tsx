import type {
  BranchWire,
  CompanyWire,
  InvoiceStatus,
  InvoiceType,
  InvoiceWire,
} from '@/lib/types'
import { formatDate, formatDateTime, formatMoney } from '@/lib/format'

const METHOD_LABELS: Record<string, string> = {
  CASH: 'Cash',
  MPESA: 'M-Pesa',
  TIGOPESA: 'Tigo Pesa',
  AIRTEL: 'Airtel Money',
  CARD: 'Card',
  BANK: 'Bank transfer',
}

const TYPE_LABELS: Record<InvoiceType, string> = {
  REPAIR_OW: 'Repair (out of warranty)',
  PARTS_SALE: 'Parts sale',
  PRODUCT_SALE: 'Product sale',
  ACCESSORY: 'Accessory sale',
}

const STATUS_LABELS: Record<InvoiceStatus, string> = {
  DRAFT: 'Unpaid',
  PARTIAL: 'Part-paid',
  PAID: 'Paid',
  VOID: 'Void',
  REFUNDED: 'Refunded',
}

function TotalRow({
  label,
  value,
  strong,
}: {
  label: string
  value: string
  strong?: boolean
}) {
  return (
    <div
      className={
        'flex justify-between gap-6 ' +
        (strong ? 'text-[15px] font-bold' : 'text-black/70')
      }
    >
      <span>{label}</span>
      <span className={strong ? '' : 'font-medium text-black'}>{value}</span>
    </div>
  )
}

/**
 * A4-style professional invoice document (screen preview + print). Isolated for
 * printing via the `.invoice-print` class (index.css @media print). Always
 * black-on-white so it prints cleanly in either app theme.
 */
export function InvoiceDocument({
  invoice,
  company,
  branch,
}: {
  invoice: InvoiceWire
  company?: CompanyWire | null
  branch?: BranchWire | null
}) {
  const c = invoice.currency
  const balance = BigInt(invoice.balance)
  const paid = BigInt(invoice.amount_paid)

  return (
    <div className="invoice-print mx-auto w-full max-w-2xl bg-white p-8 text-[13px] leading-relaxed text-black">
      {/* Header */}
      <div className="flex items-start justify-between gap-6 border-b-2 border-black/80 pb-4">
        <div>
          <div className="text-xl font-bold uppercase tracking-wide">
            {company?.name ?? 'TriServe'}
          </div>
          {company?.legal_name && (
            <div className="text-black/70">{company.legal_name}</div>
          )}
          {branch?.address && <div className="text-black/70">{branch.address}</div>}
          {(branch?.phone ?? company?.phone) && (
            <div className="text-black/70">Tel: {branch?.phone ?? company?.phone}</div>
          )}
          {company?.tin && <div className="text-black/70">TIN: {company.tin}</div>}
        </div>
        <div className="text-right">
          <div className="text-2xl font-bold tracking-[0.2em] text-black/80">
            INVOICE
          </div>
          <div className="mt-1 font-mono text-[15px]">{invoice.invoice_no}</div>
          <div className="text-black/70">{formatDate(invoice.created_at)}</div>
          <div className="mt-2 inline-block rounded border border-black/40 px-2 py-0.5 text-[11px] font-bold uppercase tracking-wide">
            {STATUS_LABELS[invoice.status]}
          </div>
        </div>
      </div>

      {/* Bill-to + meta */}
      <div className="flex flex-wrap justify-between gap-6 py-4">
        <div>
          <div className="text-[11px] font-semibold uppercase tracking-wide text-black/50">
            Bill to
          </div>
          <div className="text-[15px] font-semibold">
            {invoice.customer_name ?? 'Walk-in customer'}
          </div>
          {invoice.customer_name && (
            <div className="text-black/60">
              {invoice.customer_is_dealer ? 'Dealer / trade account' : 'Retail customer'}
            </div>
          )}
        </div>
        <div className="text-right text-black/70">
          {invoice.job_no && (
            <div>
              Job card: <span className="font-mono text-black">{invoice.job_no}</span>
            </div>
          )}
          <div>Branch: {branch?.name ?? invoice.branch_code}</div>
          <div>Served by: {invoice.sold_by}</div>
          <div>{TYPE_LABELS[invoice.type]}</div>
        </div>
      </div>

      {/* Line items */}
      <table className="w-full border-collapse">
        <thead>
          <tr className="border-y border-black/30 text-[11px] uppercase tracking-wide text-black/60">
            <th className="py-2 text-left font-semibold">Description</th>
            <th className="py-2 text-right font-semibold">Qty</th>
            <th className="py-2 text-right font-semibold">Unit price</th>
            <th className="py-2 text-right font-semibold">Amount</th>
          </tr>
        </thead>
        <tbody>
          {invoice.lines.map((l) => (
            <tr key={l.id} className="border-b border-black/10 align-top">
              <td className="py-2 pr-2">{l.description}</td>
              <td className="py-2 text-right tabular-nums">{l.qty}</td>
              <td className="py-2 text-right tabular-nums">
                {formatMoney(l.unit_price, c)}
              </td>
              <td className="py-2 text-right font-medium tabular-nums">
                {formatMoney(l.line_total, c)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {/* Totals */}
      <div className="mt-4 flex justify-end">
        <div className="w-72 space-y-1">
          <TotalRow label="Subtotal" value={formatMoney(invoice.subtotal, c)} />
          {BigInt(invoice.discount) > 0n && (
            <TotalRow
              label="Discount"
              value={`- ${formatMoney(invoice.discount, c)}`}
            />
          )}
          {BigInt(invoice.tax) > 0n && (
            <TotalRow label="VAT" value={formatMoney(invoice.tax, c)} />
          )}
          <div className="my-1 border-t border-black/30" />
          <TotalRow label="Total" value={formatMoney(invoice.total, c)} strong />
          {paid > 0n && (
            <TotalRow label="Amount paid" value={formatMoney(invoice.amount_paid, c)} />
          )}
          {balance > 0n && (
            <TotalRow label="Balance due" value={formatMoney(invoice.balance, c)} strong />
          )}
        </div>
      </div>

      {/* Payments */}
      {invoice.payments.length > 0 && (
        <div className="mt-6">
          <div className="text-[11px] font-semibold uppercase tracking-wide text-black/50">
            Payments received
          </div>
          <div className="mt-1 space-y-0.5">
            {invoice.payments.map((p) => (
              <div key={p.id} className="flex justify-between text-black/70">
                <span>
                  {formatDateTime(p.paid_at)} · {METHOD_LABELS[p.method] ?? p.method}
                  {p.reference ? ` · ${p.reference}` : ''}
                </span>
                <span className="font-medium text-black">
                  {formatMoney(p.amount, p.currency)}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {invoice.notes && (
        <div className="mt-6 text-black/70">
          <span className="font-semibold text-black">Notes: </span>
          {invoice.notes}
        </div>
      )}

      <div className="mt-10 border-t border-black/20 pt-3 text-center text-[11px] text-black/50">
        Thank you for your business · Powered by TriServe
      </div>
    </div>
  )
}
