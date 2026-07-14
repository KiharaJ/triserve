import type { BranchWire, CompanyWire, InvoiceWire } from '@/lib/types'
import { formatDateTime, formatMoney } from '@/lib/format'

const METHOD_LABELS: Record<string, string> = {
  CASH: 'Cash',
  MPESA: 'M-Pesa',
  TIGOPESA: 'Tigo Pesa',
  AIRTEL: 'Airtel Money',
  CARD: 'Card',
  BANK: 'Bank transfer',
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-2">
      <span className="text-black/70">{label}</span>
      <span className="text-right font-medium">{value}</span>
    </div>
  )
}

function Divider() {
  return <div className="my-1.5 border-t border-dashed border-black/40" />
}

/**
 * Print-ready sales receipt (80mm thermal width, also fine on A4). Always black
 * on white so it prints correctly in either app theme. Marked `.receipt-print`
 * so the print stylesheet (index.css) can isolate it from the rest of the page.
 */
export function Receipt({
  invoice,
  company,
  branch,
}: {
  invoice: InvoiceWire
  company?: CompanyWire | null
  branch?: BranchWire | null
}) {
  const balance = BigInt(invoice.balance)
  const hasProduct = invoice.lines.some((l) => l.line_type === 'PRODUCT')

  return (
    <div className="receipt-print mx-auto w-[80mm] max-w-full bg-white p-4 font-mono text-[12px] leading-tight text-black">
      {/* Shop header */}
      <div className="text-center">
        <div className="text-[15px] font-bold uppercase tracking-wide">
          {company?.name ?? 'TriServe'}
        </div>
        {company?.legal_name && <div>{company.legal_name}</div>}
        {branch && (
          <div>
            {branch.name}
            {branch.code ? ` (${branch.code})` : ''}
          </div>
        )}
        {branch?.address && <div>{branch.address}</div>}
        {(branch?.phone ?? company?.phone) && (
          <div>Tel: {branch?.phone ?? company?.phone}</div>
        )}
        {company?.tin && <div>TIN: {company.tin}</div>}
      </div>

      <Divider />
      <div className="text-center font-bold">SALES RECEIPT</div>
      <Divider />

      {/* Meta */}
      <Row label="Receipt #" value={invoice.invoice_no} />
      <Row label="Date" value={formatDateTime(invoice.created_at)} />
      <Row label="Served by" value={invoice.sold_by} />
      <Row label="Customer" value={invoice.customer_name ?? 'Walk-in'} />
      {invoice.job_no && <Row label="Job" value={invoice.job_no} />}

      <Divider />

      {/* Line items */}
      <div className="flex justify-between font-semibold">
        <span>Item</span>
        <span>Amount</span>
      </div>
      {invoice.lines.map((l) => (
        <div key={l.id} className="mt-1">
          <div>{l.description}</div>
          <div className="flex justify-between">
            <span className="text-black/70">
              {l.qty} × {formatMoney(l.unit_price, invoice.currency)}
            </span>
            <span className="font-medium">
              {formatMoney(l.line_total, invoice.currency)}
            </span>
          </div>
        </div>
      ))}

      <Divider />

      {/* Totals */}
      <Row label="Subtotal" value={formatMoney(invoice.subtotal, invoice.currency)} />
      {BigInt(invoice.discount) > 0n && (
        <Row
          label="Discount"
          value={`- ${formatMoney(invoice.discount, invoice.currency)}`}
        />
      )}
      {BigInt(invoice.tax) > 0n && (
        <Row label="VAT" value={formatMoney(invoice.tax, invoice.currency)} />
      )}
      <div className="mt-1 flex justify-between text-[14px] font-bold">
        <span>TOTAL</span>
        <span>{formatMoney(invoice.total, invoice.currency)}</span>
      </div>

      <Divider />

      {/* Payments */}
      {invoice.payments.length === 0 && (
        <div className="text-black/70">No payment recorded</div>
      )}
      {invoice.payments.map((p) => (
        <Row
          key={p.id}
          label={`${METHOD_LABELS[p.method] ?? p.method}${p.reference ? ` · ${p.reference}` : ''}`}
          value={formatMoney(p.amount, p.currency)}
        />
      ))}
      <Row label="Amount paid" value={formatMoney(invoice.amount_paid, invoice.currency)} />
      {balance > 0n && (
        <Row label="Balance due" value={formatMoney(invoice.balance, invoice.currency)} />
      )}

      <Divider />
      {hasProduct && (
        <div className="text-center text-[11px]">
          Keep this receipt as proof of purchase for any warranty claim.
        </div>
      )}
      <div className="mt-2 text-center font-bold">Thank you for your business!</div>
      <div className="text-center text-[10px] text-black/60">Powered by TriServe</div>
    </div>
  )
}
