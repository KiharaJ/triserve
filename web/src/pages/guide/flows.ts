/**
 * The process flows shown on /guide.
 *
 * Kept as DATA, not JSX, so the page stays a renderer and a flow can be
 * corrected without touching layout. Every step names the screen that does
 * the work (`to`), so the guide is navigable rather than just readable — the
 * complaint it exists to answer is "where do I go to do this".
 *
 * `watchOut` is for the thing that actually bites people: a guard that will
 * block them, a field that decides money, a step that cannot be undone.
 */
export interface FlowStep {
  title: string
  /** One line: what the person actually does here. */
  detail: string
  /** Route this step happens on, when there is one. */
  to?: string
  /** Roles that can perform it, as plain labels. */
  who: string[]
  /** The trap at this step, if any. */
  watchOut?: string
}

export interface Flow {
  key: string
  /** Module name as staff would say it. */
  title: string
  /** Who this flow belongs to. */
  owner: string
  summary: string
  /** Tailwind accent classes for the rail + chips. */
  accent: { dot: string; line: string; chip: string }
  steps: FlowStep[]
}

export const FLOWS: Flow[] = [
  {
    key: 'front-desk',
    title: 'Front desk',
    owner: 'Service advisor',
    summary:
      'First contact with the customer: take the device in, rule the warranty, and hand back a signed job card.',
    accent: {
      dot: 'bg-blue-500',
      line: 'bg-blue-500/25',
      chip: 'bg-blue-500/15 text-blue-700 dark:text-blue-300',
    },
    steps: [
      {
        title: 'Find or create the customer',
        detail:
          'Search by phone first — a returning customer keeps their history and device list.',
        to: '/jobs/new',
        who: ['Service advisor', 'Branch manager'],
        watchOut:
          'Search before you type a new name. Two records for one phone number split the customer’s repair history in half.',
      },
      {
        title: 'Take in the device',
        detail:
          'Scan the IMEI/serial, pick the model, note the colour and the purchase date from the receipt.',
        to: '/jobs/new',
        who: ['Service advisor'],
        watchOut:
          'The purchase date is what decides warranty when no registration matches — get it off the receipt while the customer is still standing there.',
      },
      {
        title: 'Rule the warranty',
        detail:
          'If a warranty registration matches the serial, apply it. Otherwise set who pays: full, labour-only, parts-only, or the customer.',
        to: '/jobs/new',
        who: ['Service advisor', 'Branch manager'],
        watchOut:
          'This decides who gets billed. Leaving it UNKNOWN means the job is treated as chargeable and repair will be blocked until a quote is accepted.',
      },
      {
        title: 'Record what you are holding',
        detail:
          'List accessories kept with the device (SIM tray, case, charger) and take before-photos.',
        to: '/jobs/new',
        who: ['Service advisor'],
        watchOut:
          'Accessories are a custody liability. If it is not on the job card, you cannot prove it came in — or that it did not.',
      },
      {
        title: 'Capture the signature and print',
        detail:
          'The customer signs on screen; print the job ticket with the job number, coverage and accessories.',
        to: '/jobs/new',
        who: ['Service advisor'],
      },
      {
        title: 'Hand over at collection',
        detail:
          'When the job is READY, dispatch it: record who collected it and the waybill number.',
        to: '/jobs',
        who: ['Service advisor', 'Branch manager'],
        watchOut:
          'Out-of-warranty work is cash on delivery — take payment before the device leaves.',
      },
    ],
  },
  {
    key: 'workshop',
    title: 'Workshop',
    owner: 'Technician',
    summary:
      'The bench: diagnose the fault, get the parts, do the repair, prove it works.',
    accent: {
      dot: 'bg-amber-500',
      line: 'bg-amber-500/25',
      chip: 'bg-amber-500/15 text-amber-700 dark:text-amber-300',
    },
    steps: [
      {
        title: 'Pick up the job',
        detail:
          'Your assigned jobs appear on the board. Move it to DIAGNOSING when you start.',
        to: '/jobs',
        who: ['Technician'],
      },
      {
        title: 'Diagnose and record the codes',
        detail:
          'Write the technician report and set the GSPN codes: condition, symptom, defect, defect type and repair code.',
        to: '/jobs',
        who: ['Technician'],
        watchOut:
          'A wrong code does not fail here — Samsung rejects the claim weeks later, after the handset has gone back.',
      },
      {
        title: 'Quote, if the customer pays',
        detail:
          'Anything not covered by warranty is quoted and accepted before work starts.',
        to: '/invoices',
        who: ['Service advisor', 'Branch manager'],
        watchOut:
          'Repair is blocked until a quote exists on a chargeable job. A manager can override it, but the override is recorded and single-use.',
      },
      {
        title: 'Reserve and consume parts',
        detail:
          'Reserve the parts on the job; consume them when fitted so stock and cost land on the job.',
        to: '/inventory/parts',
        who: ['Technician', 'Storekeeper'],
        watchOut:
          'If the part is out of stock the job goes to AWAITING PARTS — raise a purchase order rather than leaving it stuck.',
      },
      {
        title: 'Repair, then QC',
        detail:
          'Move to IN REPAIR, then QC. QC can send it back to IN REPAIR for rework.',
        to: '/jobs',
        who: ['Technician', 'Branch manager'],
      },
      {
        title: 'Mark it ready',
        detail:
          'READY tells the front desk to call the customer. Take after-photos before it goes.',
        to: '/jobs',
        who: ['Technician'],
      },
    ],
  },
  {
    key: 'aftersales',
    title: 'Aftersales & warranty',
    owner: 'Warranty clerk',
    summary:
      'Getting paid by Samsung for in-warranty work, and honouring what we sold.',
    accent: {
      dot: 'bg-rose-500',
      line: 'bg-rose-500/25',
      chip: 'bg-rose-500/15 text-rose-700 dark:text-rose-300',
    },
    steps: [
      {
        title: 'Open the claim',
        detail:
          'Raise a claim against the finished job in USD, or read a GSPN Warranty Claim Detail PDF straight in.',
        to: '/warranty-claims',
        who: ['Warranty clerk', 'Branch manager'],
        watchOut:
          'One live claim per job. A second one is blocked unless a manager approves the override.',
      },
      {
        title: 'Check the cost split',
        detail:
          'Labour + parts + shipping + tax must add up to the claim total.',
        to: '/warranty-claims',
        who: ['Warranty clerk'],
        watchOut:
          'If they do not add up you cannot tell later WHICH part Samsung short-paid. Fix the figures rather than overriding, unless Samsung’s own paperwork disagrees.',
      },
      {
        title: 'Submit to Samsung',
        detail:
          'Add the Samsung claim number and submit. Export the CSV to file a batch in GSPN.',
        to: '/warranty-claims',
        who: ['Warranty clerk'],
      },
      {
        title: 'Reconcile the payment',
        detail:
          'Record approved, rejected or paid. Paid posts the money to the ledger against AR–Samsung.',
        to: '/warranty-claims',
        who: ['Warranty clerk', 'Accountant'],
        watchOut:
          'If the reimbursement differs from the claim, the cost split is what tells you where the shortfall was.',
      },
      {
        title: 'Register warranties we sell',
        detail:
          'When a product is sold, register its warranty against the serial so a later repair finds it.',
        to: '/warranties',
        who: ['Service advisor', 'Branch manager'],
      },
    ],
  },
  {
    key: 'inventory',
    title: 'Inventory',
    owner: 'Storekeeper',
    summary: 'Keeping the parts the workshop needs, and knowing where they are.',
    accent: {
      dot: 'bg-emerald-500',
      line: 'bg-emerald-500/25',
      chip: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300',
    },
    steps: [
      {
        title: 'Watch the reorder list',
        detail:
          'Parts below their reorder level are listed with a suggested quantity.',
        to: '/inventory/reorder',
        who: ['Storekeeper', 'Branch manager'],
      },
      {
        title: 'Raise a purchase order',
        detail: 'Order from the preferred supplier; the PO needs approval over its threshold.',
        to: '/inventory/purchase-orders',
        who: ['Storekeeper', 'Branch manager'],
      },
      {
        title: 'Receive the delivery',
        detail:
          'Book stock in against the PO with a goods received note — that is what raises on-hand quantity.',
        to: '/inventory/purchase-orders',
        who: ['Storekeeper'],
        watchOut:
          'Stock only exists once the GRN is entered. Parts sitting in a box in the back room are invisible to the workshop.',
      },
      {
        title: 'Move stock between branches',
        detail: 'Transfer parts branch to branch; the receiving branch confirms arrival.',
        to: '/inventory/transfers',
        who: ['Storekeeper', 'Branch manager'],
      },
      {
        title: 'Track serialised units',
        detail: 'Serial-tracked parts keep their own history for recall and warranty.',
        to: '/inventory/serial-units',
        who: ['Storekeeper'],
      },
    ],
  },
  {
    key: 'finance',
    title: 'Finance',
    owner: 'Cashier / accountant',
    summary: 'Billing the customer, taking the money, and keeping the books straight.',
    accent: {
      dot: 'bg-violet-500',
      line: 'bg-violet-500/25',
      chip: 'bg-violet-500/15 text-violet-700 dark:text-violet-300',
    },
    steps: [
      {
        title: 'Raise the invoice',
        detail:
          'Bill the repair, a product sale or parts. What the customer owes follows the job’s coverage.',
        to: '/invoices',
        who: ['Cashier', 'Service advisor'],
      },
      {
        title: 'Take payment',
        detail: 'Record cash, card or mobile money against the invoice.',
        to: '/invoices',
        who: ['Cashier'],
        watchOut:
          'Out-of-warranty repairs are cash on delivery — settle before the device is handed over.',
      },
      {
        title: 'Approve what needs approving',
        detail:
          'Voids, refunds, big discounts and guard overrides wait in the approvals queue.',
        to: '/approvals',
        who: ['Branch manager', 'Accountant'],
        watchOut:
          'An approved override is single-use. Approving one does not grant standing permission.',
      },
      {
        title: 'Review the books',
        detail: 'Revenue, warranty income and the ledger are on Reports.',
        to: '/reports',
        who: ['Accountant', 'Owner'],
      },
    ],
  },
  {
    key: 'manager',
    title: 'Running the centre',
    owner: 'Manager / owner',
    summary: 'Knowing what is happening right now, without asking anyone.',
    accent: {
      dot: 'bg-indigo-500',
      line: 'bg-indigo-500/25',
      chip: 'bg-indigo-500/15 text-indigo-700 dark:text-indigo-300',
    },
    steps: [
      {
        title: 'Start on the dashboard',
        detail:
          'Revenue, active jobs and the branch split — the shape of the day in one screen.',
        to: '/',
        who: ['Branch manager', 'Owner'],
      },
      {
        title: 'Watch the board',
        detail:
          'The job board shows every job by stage. A column filling up is a bottleneck.',
        to: '/jobs',
        who: ['Branch manager', 'Owner'],
      },
      {
        title: 'Check operations',
        detail: 'Throughput, turnaround and workload trends by branch.',
        to: '/operations',
        who: ['Branch manager', 'Owner'],
      },
      {
        title: 'Clear the approvals queue',
        detail:
          'Anything staff cannot do alone is waiting here. A stale queue stalls the workshop.',
        to: '/approvals',
        who: ['Branch manager', 'Owner'],
      },
      {
        title: 'Audit anything',
        detail:
          'Every change is recorded with who did it and when — including overrides and warranty rulings.',
        to: '/audit',
        who: ['Owner', 'Accountant'],
      },
    ],
  },
]
