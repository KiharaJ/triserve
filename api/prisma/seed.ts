/**
 * TriServe seed — Task 0.1 (core org + config).
 *
 * Idempotent: safe to run any number of times. Upserts by natural keys:
 *   - company by name (findFirst + create/update — name has no unique index)
 *   - branch by (company_id, code)
 *   - user by email
 *   - payment_method by (company_id, code)
 *   - approval_rule by (company_id, type)          (Task 0.5, §4.11/E8)
 *   - chart_of_accounts by (company_id, code)      (Task 0.6, §4.9/E1)
 *   - workflow_state by (company_id, code)         (Task 1.2, §4.10/E7)
 *   - workflow_transition by (company_id, from_state_id, to_state_id)
 *
 * Run with: npx prisma db seed   (wired via package.json "prisma.seed")
 */
import {
  Prisma,
  PrismaClient,
  type AccountType,
  type ApprovalType,
  type DeviceCategory,
  type HoldKind,
  type NotificationChannel,
  type RoleLimitType,
  type ServiceCodeKind,
  type WorkflowStage,
} from '@prisma/client';
import { ROLE_DESCRIPTIONS, ROLE_LABELS, USER_ROLES } from '@triserve/shared';
import * as argon2 from 'argon2';
import { SYMPTOM_TREE, CONDITION_ZONES } from './intake-tree-data';
import { randomUUID } from 'node:crypto';

const prisma = new PrismaClient();

const COMPANY_NAME = 'Samsung ASC Group';

const BRANCHES: Array<{
  code: string;
  name: string;
  isHq: boolean;
  tzRegion: string;
}> = [
  {
    code: 'DAR',
    name: 'Dar es Salaam ASC',
    isHq: true,
    tzRegion: 'Dar es Salaam',
  },
  { code: 'KRK', name: 'Kariakoo ASC', isHq: false, tzRegion: 'Dar es Salaam' },
  { code: 'ARU', name: 'Arusha ASC', isHq: false, tzRegion: 'Arusha' },
  {
    code: 'MLM',
    name: 'Moshi (Kilimanjaro) ASC',
    isHq: false,
    tzRegion: 'Kilimanjaro',
  },
  { code: 'DOD', name: 'Dodoma ASC', isHq: false, tzRegion: 'Dodoma' },
];

const PAYMENT_METHODS: Array<{ code: string; label: string }> = [
  { code: 'CASH', label: 'Cash' },
  { code: 'MPESA', label: 'M-Pesa' },
  { code: 'TIGOPESA', label: 'Tigo Pesa' },
  { code: 'AIRTEL', label: 'Airtel Money' },
  { code: 'CARD', label: 'Card' },
  { code: 'BANK', label: 'Bank Transfer' },
];

/**
 * Example approval thresholds (Task 0.5, §4.11/E8). Amounts are BIGINT
 * minor units (senti) of the company base currency — TZS 100,000 = 10,000,000.
 */
const APPROVAL_RULES: Array<{
  type: ApprovalType;
  thresholdAmount: bigint | null;
  thresholdPercent: Prisma.Decimal | null;
  note: string;
}> = [
  {
    type: 'REFUND',
    thresholdAmount: 100_000n * 100n, // TZS 100,000 in senti
    thresholdPercent: null,
    note: 'refunds of TZS 100,000 or more require approval',
  },
  {
    type: 'PRICE_OVERRIDE',
    thresholdAmount: null,
    thresholdPercent: new Prisma.Decimal(10),
    note: 'price overrides of 10% or more require approval',
  },
];

/**
 * Starter chart of accounts (Task 0.6, DESIGN.md §4.9/E1). Types follow the
 * code ranges: 1xxx ASSET, 2xxx LIABILITY, 3xxx EQUITY, 4xxx REVENUE,
 * 5xxx EXPENSE. Intentional seed data — companies extend it later (E17).
 */
const CHART_OF_ACCOUNTS: Array<{
  code: string;
  name: string;
  type: AccountType;
}> = [
  { code: '1000', name: 'Cash', type: 'ASSET' },
  { code: '1010', name: 'Bank', type: 'ASSET' },
  { code: '1200', name: 'AR–Samsung', type: 'ASSET' },
  { code: '1300', name: 'Inventory', type: 'ASSET' },
  { code: '2000', name: 'AP–Suppliers', type: 'LIABILITY' },
  { code: '2100', name: 'VAT Payable', type: 'LIABILITY' },
  { code: '3000', name: "Owner's Equity", type: 'EQUITY' },
  { code: '4000', name: 'Repair Revenue', type: 'REVENUE' },
  { code: '4010', name: 'Warranty Revenue', type: 'REVENUE' },
  { code: '5000', name: 'COGS', type: 'EXPENSE' },
];

/**
 * The service lines the centre offers (§4.3) — what the customer is ASKING
 * FOR, as distinct from the device's Samsung repair grouping.
 *
 * A starting set only: this is a config table precisely so a centre adds its
 * own lines (installation, diagnostics-only, insurance work) without a
 * release. SLA hours are the normal promised turnaround for the line — an
 * in-home AC callout is not a same-week job like a handset on the bench.
 */
const SERVICE_CATEGORIES: Array<{
  code: string;
  label: string;
  defaultSlaHours: number | null;
  sortOrder: number;
}> = [
  {
    code: 'MOBILE',
    label: 'Mobile / handset repair',
    defaultSlaHours: 48,
    sortOrder: 10,
  },
  {
    code: 'CE',
    label: 'TV / audio repair',
    defaultSlaHours: 72,
    sortOrder: 20,
  },
  {
    code: 'AC_REF',
    label: 'AC & refrigeration',
    defaultSlaHours: 96,
    sortOrder: 30,
  },
  {
    code: 'GENERAL',
    label: 'General repair',
    defaultSlaHours: null,
    sortOrder: 40,
  },
];

/**
 * Samsung GSPN diagnostic codes (§4.7) — a STARTER set, not the full list.
 *
 * Every code here is one observed on a real Samsung document (the GSPN
 * Warranty Claim Detail and Service Order sheet for SM-A065F). Samsung's
 * complete code list is far larger and is theirs to publish — it is imported
 * per company via the service-codes admin endpoints rather than invented here,
 * because a wrong code does not fail loudly: GSPN rejects the claim weeks
 * later, after the repair is already given away.
 *
 * DEFECT_BLOCK has no entries: both source documents left it unselected, so
 * there is nothing to seed that would not be a guess.
 *
 * All are `HHP` — both documents are handsets.
 */
const SERVICE_CODES: Array<{
  kind: ServiceCodeKind;
  code: string;
  label: string;
  sortOrder: number;
}> = [
  { kind: 'CONDITION', code: '1', label: 'Defect', sortOrder: 10 },
  {
    kind: 'SYMPTOM',
    code: 'T83',
    label: 'USB connectivity problem',
    sortOrder: 10,
  },
  { kind: 'SYMPTOM', code: 'L3', label: 'Lock', sortOrder: 20 },
  { kind: 'DEFECT', code: 'Q', label: 'Short', sortOrder: 10 },
  { kind: 'DEFECT', code: '03', label: 'Device Lock', sortOrder: 20 },
  { kind: 'DEFECT_TYPE', code: 'L2', label: 'Level 2 Service', sortOrder: 10 },
  {
    kind: 'REPAIR',
    code: 'A01',
    label: 'Electrical parts replacement',
    sortOrder: 10,
  },
];

// ===========================================================================
// SCMS proposal seed data (Service_Center_System_Proposal.docx)
// ===========================================================================

/**
 * Module 5 (§6) — the proposal's approval matrix as DATA.
 *
 *   Front Counter Agent  "can accept standard invoice payments, cannot grant
 *                         discounts"                → DISCOUNT ceiling of 0
 *   Repair Technician    "parts matching diagnostic codes up to a $5 minor
 *                         consumable variance"      → PARTS_VARIANCE $5
 *   Floor Supervisor     "OW price adjustments up to $200… requires Center
 *                         Manager approval for full write-offs"
 *                                                   → PRICE_ADJUSTMENT $200,
 *                                                      WRITE_OFF 0
 *   Center Manager       "Full authorization"       → enabled:false everywhere
 *                                                      (no ceiling at all)
 *
 * The proposal quotes USD figures; the centre trades in TZS, so the ceilings
 * are seeded in USD cents against an explicit `USD` currency rather than
 * silently reinterpreting "$200" as shillings. A company retunes them in its
 * own currency from the roles screen — that is what the table is for.
 *
 * A MISSING row denies outright; `enabled: false` means unlimited. Both are
 * written explicitly below so no reader has to infer intent from absence.
 */
const ROLE_LIMITS: Array<{
  role: string;
  type: RoleLimitType;
  maxAmount: bigint | null;
  currency: string | null;
  maxPercent: Prisma.Decimal | null;
  enabled: boolean;
  note: string;
}> = [
  {
    role: 'SERVICE_ADVISOR',
    type: 'DISCOUNT',
    maxAmount: 0n,
    currency: 'USD',
    maxPercent: new Prisma.Decimal(0),
    enabled: true,
    note: 'front counter cannot grant discounts',
  },
  {
    role: 'SERVICE_ADVISOR',
    type: 'PRICE_ADJUSTMENT',
    maxAmount: 0n,
    currency: 'USD',
    maxPercent: null,
    enabled: true,
    note: 'front counter cannot adjust prices',
  },
  {
    role: 'TECHNICIAN',
    type: 'PARTS_VARIANCE',
    maxAmount: 500n, // USD 5.00
    currency: 'USD',
    maxPercent: null,
    enabled: true,
    note: 'technician: $5 minor consumable variance',
  },
  {
    role: 'FLOOR_SUPERVISOR',
    type: 'PRICE_ADJUSTMENT',
    maxAmount: 20_000n, // USD 200.00
    currency: 'USD',
    maxPercent: null,
    enabled: true,
    note: 'floor supervisor: OW price adjustments up to $200',
  },
  {
    role: 'FLOOR_SUPERVISOR',
    type: 'DISCOUNT',
    maxAmount: 20_000n,
    currency: 'USD',
    maxPercent: new Prisma.Decimal(25),
    enabled: true,
    note: 'floor supervisor: discounts up to $200 / 25%',
  },
  {
    role: 'FLOOR_SUPERVISOR',
    type: 'WRITE_OFF',
    maxAmount: 0n,
    currency: 'USD',
    maxPercent: null,
    enabled: true,
    note: 'write-offs escalate to the Centre Manager',
  },
  {
    role: 'BRANCH_MANAGER',
    type: 'DISCOUNT',
    maxAmount: null,
    currency: null,
    maxPercent: null,
    enabled: false,
    note: 'Centre Manager: full authorization',
  },
  {
    role: 'BRANCH_MANAGER',
    type: 'PRICE_ADJUSTMENT',
    maxAmount: null,
    currency: null,
    maxPercent: null,
    enabled: false,
    note: 'Centre Manager: full authorization',
  },
  {
    role: 'BRANCH_MANAGER',
    type: 'WRITE_OFF',
    maxAmount: null,
    currency: null,
    maxPercent: null,
    enabled: false,
    note: 'Centre Manager: approves stock write-offs and BER',
  },
  {
    role: 'BRANCH_MANAGER',
    type: 'REFUND',
    maxAmount: null,
    currency: null,
    maxPercent: null,
    enabled: false,
    note: 'Centre Manager: full authorization',
  },
];


/**
 * Module 2 (§3) — mandatory calibration logs before a device exits QC.
 *
 * "For example, flagship mobile devices must pass an automated pressure/
 * water-resistance calibration test, with raw log files uploaded to the
 * record." That example is seeded literally as PRESSURE_TEST; the rest are the
 * checks a handset/TV/AC/fridge genuinely cannot ship without.
 */
const QC_CHECKLIST: Array<{
  category: DeviceCategory;
  code: string;
  label: string;
  help?: string;
  requiresValue?: boolean;
  requiresAttachment?: boolean;
  blocking?: boolean;
  sortOrder: number;
}> = [
  {
    category: 'HHP',
    code: 'PRESSURE_TEST',
    label: 'Pressure / water-resistance calibration',
    help: 'Run the automated seal test and enter the measured pressure (kPa). Attach the raw log file to the job.',
    requiresValue: true,
    requiresAttachment: true,
    sortOrder: 10,
  },
  {
    category: 'HHP',
    code: 'FLASH_CHECK',
    label: 'Software flash / firmware version verified',
    help: 'Confirm the handset boots on the expected firmware build.',
    requiresValue: true,
    sortOrder: 20,
  },
  {
    category: 'HHP',
    code: 'TOUCH_GRID',
    label: 'Full touch-grid sweep',
    sortOrder: 30,
  },
  {
    category: 'HHP',
    code: 'CAMERA_TEST',
    label: 'Front & rear camera capture',
    sortOrder: 40,
  },
  {
    category: 'HHP',
    code: 'CHARGE_TEST',
    label: 'Charge & battery health check',
    requiresValue: true,
    sortOrder: 50,
  },
  {
    category: 'HHP',
    code: 'IMEI_MATCH',
    label: 'IMEI still matches the job card',
    help: 'Catches a unit mixed up on the bench before it reaches the customer.',
    sortOrder: 60,
  },
  {
    category: 'HHP',
    code: 'COSMETIC',
    label: 'Cosmetic condition matches intake photos',
    blocking: false,
    sortOrder: 70,
  },
  {
    category: 'CE',
    code: 'PANEL_UNIFORMITY',
    label: 'Panel uniformity / dead-pixel sweep',
    sortOrder: 10,
  },
  {
    category: 'CE',
    code: 'INPUT_TEST',
    label: 'All HDMI / USB inputs verified',
    sortOrder: 20,
  },
  {
    category: 'CE',
    code: 'FIRMWARE',
    label: 'Firmware version verified',
    requiresValue: true,
    sortOrder: 30,
  },
  {
    category: 'AC',
    code: 'GAS_PRESSURE',
    label: 'Refrigerant pressure within spec',
    requiresValue: true,
    requiresAttachment: true,
    sortOrder: 10,
  },
  {
    category: 'AC',
    code: 'COOLING_DELTA',
    label: 'Inlet/outlet temperature differential',
    requiresValue: true,
    sortOrder: 20,
  },
  {
    category: 'AC',
    code: 'LEAK_TEST',
    label: 'Leak test passed',
    sortOrder: 30,
  },
  {
    category: 'REF',
    code: 'TEMP_PULLDOWN',
    label: 'Cabinet pull-down to set temperature',
    requiresValue: true,
    sortOrder: 10,
  },
  {
    category: 'REF',
    code: 'DOOR_SEAL',
    label: 'Door seal / gasket integrity',
    sortOrder: 20,
  },
  {
    category: 'REF',
    code: 'COMPRESSOR_RUN',
    label: 'Compressor run current within spec',
    requiresValue: true,
    sortOrder: 30,
  },
];

/**
 * Module 7 (§8) / DESIGN §4.13 — starter notification templates.
 *
 * `{{token}}` placeholders are resolved from the event payload at enqueue
 * time. SMS bodies are kept inside one 160-character segment where possible:
 * a two-segment message costs twice as much, and these fire on every job.
 * Swahili variants ship alongside English because `customers.preferred_language`
 * already selects between them (§4.2) — a customer who set SW and receives EN
 * is a bug, not a missing feature.
 */
const NOTIFICATION_TEMPLATES: Array<{
  eventCode: string;
  channel: NotificationChannel;
  language: 'EN' | 'SW';
  subject?: string;
  body: string;
}> = [
  {
    eventCode: 'JOB_BOOKED',
    channel: 'SMS',
    language: 'EN',
    body: '{{company}}: job {{job_no}} opened for your {{device}}. We will text you when it is ready. Ref {{job_no}}.',
  },
  {
    eventCode: 'JOB_BOOKED',
    channel: 'SMS',
    language: 'SW',
    body: '{{company}}: kazi {{job_no}} imefunguliwa kwa {{device}} yako. Tutakutumia ujumbe ikiwa tayari. Kumb. {{job_no}}.',
  },
  {
    eventCode: 'QUOTE_APPROVAL',
    channel: 'SMS',
    language: 'EN',
    body: '{{company}}: repair quote for {{job_no}} is {{amount}}. Approve here: {{link}} (expires {{expires}}).',
  },
  {
    eventCode: 'QUOTE_APPROVAL',
    channel: 'SMS',
    language: 'SW',
    body: '{{company}}: gharama ya matengenezo {{job_no}} ni {{amount}}. Thibitisha hapa: {{link}} (inaisha {{expires}}).',
  },
  {
    eventCode: 'AWAITING_PARTS',
    channel: 'SMS',
    language: 'EN',
    body: '{{company}}: job {{job_no}} is waiting on a spare part. We will update you as soon as it arrives.',
  },
  {
    eventCode: 'JOB_READY',
    channel: 'SMS',
    language: 'EN',
    body: '{{company}}: {{device}} (job {{job_no}}) is ready for collection at {{branch}}.',
  },
  {
    eventCode: 'JOB_READY',
    channel: 'SMS',
    language: 'SW',
    body: '{{company}}: {{device}} (kazi {{job_no}}) iko tayari kuchukuliwa {{branch}}.',
  },
  {
    // The PIN travels in its OWN message, never bundled with anything else:
    // a collection code forwarded along with other text is a code that has
    // left the customer's control.
    eventCode: 'COLLECTION_OTP',
    channel: 'SMS',
    language: 'EN',
    body: '{{company}}: your collection PIN for job {{job_no}} is {{otp}}. Show it at the counter. Do not share it.',
  },
  {
    eventCode: 'COLLECTION_OTP',
    channel: 'SMS',
    language: 'SW',
    body: '{{company}}: PIN yako ya kuchukua kazi {{job_no}} ni {{otp}}. Ionyeshe kaunta. Usimpe mtu mwingine.',
  },
  {
    eventCode: 'BER_NOTICE',
    channel: 'SMS',
    language: 'EN',
    body: '{{company}}: job {{job_no}} — repair cost exceeds the device value. Please call {{branch_phone}} to discuss your options.',
  },
  {
    eventCode: 'JOB_DISPATCHED',
    channel: 'SMS',
    language: 'EN',
    body: '{{company}}: job {{job_no}} was collected on {{date}}. Thank you.',
  },
  {
    eventCode: 'CSAT_REQUEST',
    channel: 'SMS',
    language: 'EN',
    body: '{{company}}: how did we do on job {{job_no}}? Rate us here: {{link}}',
  },
  {
    eventCode: 'CSAT_REQUEST',
    channel: 'SMS',
    language: 'SW',
    body: '{{company}}: tulifanyaje kwenye kazi {{job_no}}? Tupe maoni: {{link}}',
  },
  {
    eventCode: 'JOB_READY',
    channel: 'EMAIL',
    language: 'EN',
    subject: '{{device}} ready for collection — job {{job_no}}',
    body: 'Hello {{customer}},\n\nYour {{device}} (job {{job_no}}) has passed quality checks and is ready for collection at {{branch}}.\n\nPlease bring the collection PIN we texted you.\n\n{{company}}',
  },
  {
    eventCode: 'QUOTE_APPROVAL',
    channel: 'EMAIL',
    language: 'EN',
    subject: 'Repair quote for job {{job_no}}',
    body: 'Hello {{customer}},\n\nThe repair quote for your {{device}} (job {{job_no}}) is {{amount}}.\n\nApprove it here: {{link}}\nThis link expires {{expires}}.\n\nWork will not start until you approve.\n\n{{company}}',
  },
];

/**
 * DEFAULT workflow (Task 1.2, DESIGN.md §4.10/§5/E7) — the §5 job lifecycle
 * as seeded data. Companies reshape it later via /workflow/* admin endpoints.
 */
const WORKFLOW_STATES: Array<{
  code: string;
  label: string;
  isInitial?: boolean;
  isTerminal?: boolean;
  sortOrder: number;
  /**
   * SCMS proposal Module 2 — what the state means to the KPI clocks. `stage`
   * drives Clock-to-Diagnosis / Hold-for-Parts / Turnaround; `holdKind` says
   * why a hold is holding; `pausesSla` stops the CUSTOMER-facing countdown
   * while the internal clock keeps running.
   */
  stage: WorkflowStage;
  holdKind?: HoldKind;
  pausesSla?: boolean;
}> = [
  {
    code: 'BOOKED',
    label: 'Booked',
    isInitial: true,
    sortOrder: 10,
    stage: 'INTAKE',
  },
  /// The ASSIGNED ENGINEER's own attestation that they physically have the
  /// device — distinct from booking (the front desk logging intake). A job
  /// sits here between being booked/assigned and diagnosis actually starting.
  {
    code: 'RECEIVED',
    label: 'Received',
    sortOrder: 15,
    stage: 'INTAKE',
  },
  {
    code: 'DIAGNOSING',
    label: 'Diagnosing',
    sortOrder: 20,
    stage: 'DIAGNOSIS',
  },
  {
    code: 'AWAITING_CUSTOMER_APPROVAL',
    label: 'Awaiting Customer Approval',
    sortOrder: 30,
    stage: 'HOLD',
    holdKind: 'CUSTOMER',
    pausesSla: true,
  },
  {
    code: 'AWAITING_PARTS',
    label: 'Awaiting Parts',
    sortOrder: 40,
    stage: 'HOLD',
    holdKind: 'PARTS',
    pausesSla: true,
  },
  { code: 'IN_REPAIR', label: 'In Repair', sortOrder: 50, stage: 'REPAIR' },
  { code: 'QC', label: 'Quality Check', sortOrder: 60, stage: 'QC' },
  {
    code: 'READY',
    label: 'Ready for Collection',
    sortOrder: 70,
    stage: 'READY',
  },
  { code: 'DISPATCHED', label: 'Dispatched', sortOrder: 80, stage: 'DONE' },
  {
    code: 'CLOSED',
    label: 'Closed',
    isTerminal: true,
    sortOrder: 90,
    stage: 'DONE',
  },
  {
    code: 'CANCELLED',
    label: 'Cancelled',
    isTerminal: true,
    sortOrder: 100,
    stage: 'DONE',
  },
  {
    code: 'RETURNED_UNREPAIRED',
    label: 'Returned Unrepaired',
    isTerminal: true,
    sortOrder: 110,
    stage: 'DONE',
  },
];

/**
 * Default transition edges + permission mapping:
 *   - 'job.transition'          front-desk/general moves (intake, diagnosis
 *                               routing, cancellations) — every job role.
 *   - 'job.transition.repair'   bench moves (→IN_REPAIR, →QC, QC→READY) —
 *                               TECHNICIAN + BRANCH_MANAGER (+SUPER_ADMIN).
 *   - 'job.transition.dispatch' handover moves (READY→DISPATCHED,
 *                               DISPATCHED→CLOSED) — SERVICE_ADVISOR +
 *                               BRANCH_MANAGER (+SUPER_ADMIN); technicians
 *                               deliberately cannot dispatch.
 *
 * GUARDS (SCMS proposal §3 "Conditional Enforcements", §4 step 4, §6). An edge
 * may name SEVERAL guards, comma-separated — ALL must pass. The proposal's
 * enforcement table maps onto the seeded lifecycle like this:
 *
 *   BOOKED      → RECEIVED    engineer_skill_match (the proposal's
 *                             BOOKED→ASSIGNED skill rule — the technician
 *                             accepting the device must be certified for it)
 *   RECEIVED    → DIAGNOSING  intake_evidence_complete (the counter's
 *                             evidence pack must be complete before the
 *                             device that's now on the bench gets diagnosed)
 *   DIAGNOSING  → IN_REPAIR   — via AWAITING_CUSTOMER_APPROVAL / AWAITING_PARTS
 *   AWAIT_CUST  → IN_REPAIR   ow_quote_approved, ber_not_blocking
 *   AWAIT_PARTS → IN_REPAIR   ber_not_blocking
 *   IN_REPAIR   → QC          repair_work_declared, core_returns_complete
 *   QC          → READY       qc_checklist_passed
 *   QC          → IN_REPAIR   qc_failure_logged
 *   READY       → DISPATCHED  collection_otp_verified
 *
 * Every one of these is overridable by an approved manager override where a
 * mapping exists in GUARD_OVERRIDE_TYPE (jobs.service.ts) — the gates are hard
 * by default and openable on the record, never silently bypassable.
 */
const WORKFLOW_TRANSITIONS: Array<{
  from: string;
  to: string;
  requiredPermission: string | null;
  requiresApproval?: boolean;
  guardCode?: string | null;
}> = [
  {
    from: 'BOOKED',
    to: 'RECEIVED',
    requiredPermission: 'job.transition',
    // §3: the technician holding the job must be certified for the device
    // class. Nobody-assigned-yet passes (see the guard's own doc comment) —
    // TriServe's counter flow can hand a device to the bench before anyone
    // has formally picked it up.
    guardCode: 'engineer_skill_match',
  },
  { from: 'BOOKED', to: 'CANCELLED', requiredPermission: 'job.transition' },
  {
    from: 'RECEIVED',
    to: 'DIAGNOSING',
    requiredPermission: 'job.transition',
    // §2: the counter's evidence pack must be complete before the device
    // that's now on the bench gets diagnosed.
    guardCode: 'intake_evidence_complete',
  },
  { from: 'RECEIVED', to: 'CANCELLED', requiredPermission: 'job.transition' },
  {
    from: 'DIAGNOSING',
    to: 'AWAITING_CUSTOMER_APPROVAL',
    requiredPermission: 'job.transition',
  },
  {
    from: 'DIAGNOSING',
    to: 'AWAITING_PARTS',
    requiredPermission: 'job.transition',
    // Don't park a job in an SLA-PAUSING hold with nothing on order: the bench
    // must have raised a parts request first, so the hold means what it says.
    guardCode: 'parts_requested',
  },
  {
    // Skip the parts hold entirely when the bench needs nothing, or needs only
    // what is already on the shelf. Without this edge every job had to pass
    // through AWAITING_PARTS or AWAITING_CUSTOMER_APPROVAL to reach repair,
    // pausing the SLA clock for a wait that was not happening. Still fully
    // gated: an out-of-warranty job needs its approved quote, a BER-flagged
    // device is blocked, and nothing may be outstanding from stores.
    from: 'DIAGNOSING',
    to: 'IN_REPAIR',
    requiredPermission: 'job.transition.repair',
    guardCode: 'ow_quote_approved,ber_not_blocking,parts_received',
  },
  {
    from: 'DIAGNOSING',
    to: 'RETURNED_UNREPAIRED',
    requiredPermission: 'job.transition',
  },
  { from: 'DIAGNOSING', to: 'CANCELLED', requiredPermission: 'job.transition' },
  {
    from: 'AWAITING_CUSTOMER_APPROVAL',
    to: 'IN_REPAIR',
    requiredPermission: 'job.transition.repair',
    requiresApproval: false,
    // §6: no billable work starts without the customer's approval or a
    // prepayment. §5: and not at all while a BER review is open.
    guardCode: 'ow_quote_approved,ber_not_blocking',
  },
  {
    from: 'AWAITING_CUSTOMER_APPROVAL',
    to: 'AWAITING_PARTS',
    requiredPermission: 'job.transition',
  },
  {
    from: 'AWAITING_CUSTOMER_APPROVAL',
    to: 'CANCELLED',
    requiredPermission: 'job.transition',
  },
  {
    from: 'AWAITING_CUSTOMER_APPROVAL',
    to: 'RETURNED_UNREPAIRED',
    requiredPermission: 'job.transition',
  },
  {
    from: 'AWAITING_PARTS',
    to: 'IN_REPAIR',
    requiredPermission: 'job.transition.repair',
    // The bench must actually HAVE the parts: approved, picked, handed over
    // and acknowledged. "Issued" is what stores asserts; the acknowledgement
    // is the technician confirming it arrived.
    guardCode: 'ber_not_blocking,parts_received',
  },
  {
    from: 'IN_REPAIR',
    to: 'QC',
    requiredPermission: 'job.transition.repair',
    // §3: actual labour hours + repair notes are mandatory. §4 step 4: the
    // defective core must be in the secure bin FIRST — the interlock the
    // proposal calls a CRITICAL STEP.
    guardCode: 'repair_work_declared,core_returns_complete',
  },
  {
    from: 'QC',
    to: 'READY',
    // §3: the QC gate is the Senior Quality Assurer's, not the bench's — a
    // technician can push INTO QC but cannot sign their own work off.
    requiredPermission: 'job.qc.approve',
    guardCode: 'qc_checklist_passed',
  },
  {
    from: 'QC',
    to: 'IN_REPAIR',
    requiredPermission: 'job.qc.approve',
    // §3: "Requires mandatory failure reason log; routes back to the same tech."
    guardCode: 'qc_failure_logged',
  }, // rework
  {
    from: 'READY',
    to: 'DISPATCHED',
    requiredPermission: 'job.transition.dispatch',
    // §7 step 4: no handover without the customer's single-use PIN.
    guardCode: 'collection_otp_verified',
  },
  {
    from: 'DISPATCHED',
    to: 'CLOSED',
    requiredPermission: 'job.transition.dispatch',
  },
  // "Step back one stage" — reverse edges so a wrong forward move can be
  // walked back one step by the same person who made it (a technician holds
  // 'job.transition' + 'job.transition.repair', not '.dispatch'). Scoped to
  // the ACTIVE repair path only: reopening a terminal state (CLOSED/CANCELLED/
  // RETURNED_UNREPAIRED) or reversing a dispatch is a bigger decision left out
  // deliberately. QC→IN_REPAIR already exists above as rework.
  { from: 'DIAGNOSING', to: 'RECEIVED', requiredPermission: 'job.transition' },
  { from: 'RECEIVED', to: 'BOOKED', requiredPermission: 'job.transition' },
  {
    from: 'AWAITING_CUSTOMER_APPROVAL',
    to: 'DIAGNOSING',
    requiredPermission: 'job.transition',
  },
  {
    from: 'AWAITING_PARTS',
    to: 'DIAGNOSING',
    requiredPermission: 'job.transition',
  },
  {
    from: 'IN_REPAIR',
    to: 'AWAITING_PARTS',
    requiredPermission: 'job.transition.repair',
  },
  { from: 'READY', to: 'QC', requiredPermission: 'job.transition.repair' },
];

async function main(): Promise<void> {
  // --- Company (upsert by name) ---------------------------------------------
  const existingCompany = await prisma.company.findFirst({
    where: { name: COMPANY_NAME },
  });
  const company = existingCompany
    ? await prisma.company.update({
        where: { id: existingCompany.id },
        data: { baseCurrency: 'TZS', active: true },
      })
    : await prisma.company.create({
        data: {
          id: randomUUID(),
          name: COMPANY_NAME,
          legalName: 'Samsung ASC Group Ltd',
          baseCurrency: 'TZS',
        },
      });
  console.log(`company:        ${company.name} (${company.id})`);

  // --- Branches (upsert by company_id + code) -------------------------------
  for (const b of BRANCHES) {
    const branch = await prisma.branch.upsert({
      where: { companyId_code: { companyId: company.id, code: b.code } },
      update: {
        name: b.name,
        isHq: b.isHq,
        tzRegion: b.tzRegion,
        active: true,
      },
      create: {
        id: randomUUID(),
        companyId: company.id,
        code: b.code,
        name: b.name,
        isHq: b.isHq,
        tzRegion: b.tzRegion,
      },
    });
    console.log(
      `branch:         ${branch.code} — ${branch.name}${branch.isHq ? ' [HQ]' : ''}`,
    );
  }

  // --- Built-in roles (upsert by company_id + key, E17b) ---------------------
  // The role registry every company starts with; custom roles are added later
  // through the admin UI. Permissions themselves stay in @triserve/shared's
  // default matrix + role_permissions overrides — these rows are the registry.
  for (const key of USER_ROLES) {
    await prisma.role.upsert({
      where: { companyId_key: { companyId: company.id, key } },
      update: { label: ROLE_LABELS[key], description: ROLE_DESCRIPTIONS[key] },
      create: {
        id: randomUUID(),
        companyId: company.id,
        key,
        label: ROLE_LABELS[key],
        description: ROLE_DESCRIPTIONS[key],
        isSystem: true,
      },
    });
  }
  console.log(`roles:          ${USER_ROLES.length} built-in roles`);

  // --- Super admin (upsert by email) -----------------------------------------
  const adminEmail = process.env.SEED_ADMIN_EMAIL ?? 'admin@triserve.local';
  const adminPassword = process.env.SEED_ADMIN_PASSWORD ?? 'ChangeMe123!';
  const passwordHash = await argon2.hash(adminPassword, {
    type: argon2.argon2id,
  });

  const admin = await prisma.user.upsert({
    where: { email: adminEmail },
    update: {
      role: 'SUPER_ADMIN',
      scope: 'group',
      active: true,
      // Keep the dev admin's password aligned with SEED_ADMIN_PASSWORD:
      // re-running the seed after changing the env (or after an older seed
      // hashed a different default) must always leave a working login.
      passwordHash,
    },
    create: {
      id: randomUUID(),
      companyId: company.id,
      fullName: 'System Administrator',
      email: adminEmail,
      passwordHash,
      role: 'SUPER_ADMIN',
      scope: 'group',
    },
  });
  console.log(
    `super admin:    ${admin.email} (role=${admin.role}, scope=${admin.scope})`,
  );

  // --- Payment methods (upsert by company_id + code) --------------------------
  for (const pm of PAYMENT_METHODS) {
    const row = await prisma.paymentMethod.upsert({
      where: { companyId_code: { companyId: company.id, code: pm.code } },
      update: { label: pm.label, active: true },
      create: {
        id: randomUUID(),
        companyId: company.id,
        code: pm.code,
        label: pm.label,
      },
    });
    console.log(`payment method: ${row.code} — ${row.label}`);
  }

  // --- Approval rules (upsert by company_id + type, Task 0.5) ----------------
  for (const r of APPROVAL_RULES) {
    const rule = await prisma.approvalRule.upsert({
      where: { companyId_type: { companyId: company.id, type: r.type } },
      update: {
        thresholdAmount: r.thresholdAmount,
        thresholdPercent: r.thresholdPercent,
        enabled: true,
      },
      create: {
        id: randomUUID(),
        companyId: company.id,
        type: r.type,
        thresholdAmount: r.thresholdAmount,
        thresholdPercent: r.thresholdPercent,
      },
    });
    console.log(`approval rule:  ${rule.type} — ${r.note}`);
  }

  // --- Chart of accounts (upsert by company_id + code, Task 0.6) -------------
  for (const a of CHART_OF_ACCOUNTS) {
    const account = await prisma.chartOfAccount.upsert({
      where: { companyId_code: { companyId: company.id, code: a.code } },
      update: { name: a.name, type: a.type, isActive: true },
      create: {
        id: randomUUID(),
        companyId: company.id,
        code: a.code,
        name: a.name,
        type: a.type,
      },
    });
    console.log(
      `account:        ${account.code} — ${account.name} [${account.type}]`,
    );
  }

  // --- Service categories (upsert by company_id + code, §4.3) --------------
  for (const c of SERVICE_CATEGORIES) {
    const sc = await prisma.serviceCategory.upsert({
      where: { companyId_code: { companyId: company.id, code: c.code } },
      update: {
        label: c.label,
        defaultSlaHours: c.defaultSlaHours,
        sortOrder: c.sortOrder,
        active: true,
      },
      create: {
        id: randomUUID(),
        companyId: company.id,
        code: c.code,
        label: c.label,
        defaultSlaHours: c.defaultSlaHours,
        sortOrder: c.sortOrder,
      },
    });
    console.log(
      `service line:   ${sc.code} — ${sc.label}` +
        (sc.defaultSlaHours ? ` (${sc.defaultSlaHours}h)` : ''),
    );
  }

  // --- Samsung GSPN diagnostic codes (upsert by company_id + kind + code,
  // --- §4.7) ----------------------------------------------------------------
  for (const c of SERVICE_CODES) {
    const sc = await prisma.serviceCode.upsert({
      where: {
        companyId_kind_code: {
          companyId: company.id,
          kind: c.kind,
          code: c.code,
        },
      },
      update: {
        label: c.label,
        category: 'HHP',
        sortOrder: c.sortOrder,
        active: true,
      },
      create: {
        id: randomUUID(),
        companyId: company.id,
        kind: c.kind,
        code: c.code,
        label: c.label,
        category: 'HHP',
        sortOrder: c.sortOrder,
      },
    });
    console.log(`service code:   ${sc.kind} ${sc.code} — ${sc.label}`);
  }

  // --- Default workflow (upsert states by company_id + code, then edges by
  // --- company_id + from + to, Task 1.2 §4.10/§5/E7) ------------------------
  const stateIdByCode = new Map<string, string>();
  for (const s of WORKFLOW_STATES) {
    const state = await prisma.workflowState.upsert({
      where: { companyId_code: { companyId: company.id, code: s.code } },
      update: {
        label: s.label,
        isInitial: s.isInitial ?? false,
        isTerminal: s.isTerminal ?? false,
        sortOrder: s.sortOrder,
        active: true,
        stage: s.stage,
        holdKind: s.holdKind ?? 'NONE',
        pausesSla: s.pausesSla ?? false,
      },
      create: {
        id: randomUUID(),
        companyId: company.id,
        code: s.code,
        label: s.label,
        isInitial: s.isInitial ?? false,
        isTerminal: s.isTerminal ?? false,
        sortOrder: s.sortOrder,
        stage: s.stage,
        holdKind: s.holdKind ?? 'NONE',
        pausesSla: s.pausesSla ?? false,
      },
    });
    stateIdByCode.set(state.code, state.id);
    const flags = [
      state.isInitial ? 'initial' : null,
      state.isTerminal ? 'terminal' : null,
    ].filter(Boolean);
    console.log(
      `workflow state: ${state.code}${flags.length ? ` [${flags.join(', ')}]` : ''}`,
    );
  }

  for (const t of WORKFLOW_TRANSITIONS) {
    const fromStateId = stateIdByCode.get(t.from);
    const toStateId = stateIdByCode.get(t.to);
    if (!fromStateId || !toStateId) {
      throw new Error(`workflow seed: unknown state in edge ${t.from}→${t.to}`);
    }
    await prisma.workflowTransition.upsert({
      where: {
        companyId_fromStateId_toStateId: {
          companyId: company.id,
          fromStateId,
          toStateId,
        },
      },
      update: {
        requiredPermission: t.requiredPermission,
        requiresApproval: t.requiresApproval ?? false,
        guardCode: t.guardCode ?? null,
        deletedAt: null,
      },
      create: {
        id: randomUUID(),
        companyId: company.id,
        fromStateId,
        toStateId,
        requiredPermission: t.requiredPermission,
        requiresApproval: t.requiresApproval ?? false,
        guardCode: t.guardCode ?? null,
      },
    });
    console.log(
      `workflow edge:  ${t.from} → ${t.to}` +
        `${t.requiredPermission ? ` (${t.requiredPermission})` : ''}` +
        `${t.guardCode ? ` [guard: ${t.guardCode}]` : ''}`,
    );
  }

  // --- Sample parts + opening stock (Task 2.1, §4.4) ------------------------
  // A few representative spare parts with opening stock at DAR/KRK so the
  // inventory API is demonstrable before the migration importer (Task 2.10)
  // loads the real catalogue. Idempotent AND non-destructive: parts are
  // upserted, but stock quantities are set on CREATE only (re-running the seed
  // never resets stock that has since been moved through the API), and the
  // opening RECEIPT ledger row is written exactly once per (branch, part).
  const branchByCode = new Map<string, string>();
  for (const b of BRANCHES) {
    const row = await prisma.branch.findFirstOrThrow({
      where: { companyId: company.id, code: b.code },
    });
    branchByCode.set(b.code, row.id);
  }

  // --- Suppliers (Task 2.5, §4.4b) — the parts vendors --------------------
  const SAMPLE_SUPPLIERS = [
    {
      name: 'Samsung Parts Distributor',
      contactPerson: 'SPD Orders Desk',
      email: 'orders@samsungparts.example',
      defaultCurrency: 'USD',
      leadTimeDays: 21,
      paymentTerms: '30 days',
    },
    {
      name: 'Dar Local Spares Ltd',
      contactPerson: 'John Mushi',
      phone: '+255754000111',
      defaultCurrency: 'TZS',
      leadTimeDays: 3,
      paymentTerms: 'Prepaid',
    },
  ];
  const supplierIdByName = new Map<string, string>();
  for (const s of SAMPLE_SUPPLIERS) {
    const supplier = await prisma.supplier.upsert({
      where: { companyId_name: { companyId: company.id, name: s.name } },
      update: {
        contactPerson: s.contactPerson ?? null,
        phone: s.phone ?? null,
        email: s.email ?? null,
        defaultCurrency: s.defaultCurrency,
        leadTimeDays: s.leadTimeDays,
        paymentTerms: s.paymentTerms,
        active: true,
      },
      create: {
        id: randomUUID(),
        companyId: company.id,
        name: s.name,
        contactPerson: s.contactPerson ?? null,
        phone: s.phone ?? null,
        email: s.email ?? null,
        defaultCurrency: s.defaultCurrency,
        leadTimeDays: s.leadTimeDays,
        paymentTerms: s.paymentTerms,
        createdById: admin.id,
        updatedById: admin.id,
      },
    });
    supplierIdByName.set(supplier.name, supplier.id);
    console.log(
      `supplier:       ${supplier.name} (${supplier.defaultCurrency})`,
    );
  }

  const SAMPLE_PARTS = [
    {
      partNumber: 'GH82-31385A',
      description: 'Galaxy S24 LCD OLED assembly (black)',
      category: 'HHP',
      unitCostUsd: 12_800n, // USD 128.00
      sellPriceTzs: 45_000_000n, // TZS 450,000
      reorderLevel: 5,
      supplier: 'Samsung Parts Distributor',
      opening: { DAR: 12, KRK: 4 },
      // SCMS proposal §4: displays, PBA mainboards and cameras are the
      // 1:1 core-exchange items — the old unit must come back.
      requiresCoreReturn: true,
    },
    {
      partNumber: 'GH82-30000B',
      description: 'Galaxy A05 LCD assembly',
      category: 'HHP',
      unitCostUsd: 3_200n,
      sellPriceTzs: 12_000_000n,
      reorderLevel: 8,
      supplier: 'Samsung Parts Distributor',
      opening: { DAR: 20, KRK: 10 },
      requiresCoreReturn: true,
    },
    {
      partNumber: 'EB-BA556ABY',
      description: 'Galaxy A55 battery pack',
      category: 'HHP',
      unitCostUsd: 1_500n,
      sellPriceTzs: 5_500_000n,
      reorderLevel: 15,
      supplier: 'Samsung Parts Distributor',
      opening: { DAR: 40, KRK: 18 },
      // Batteries are consumables, not tracked cores.
      requiresCoreReturn: false,
    },
    {
      partNumber: 'DA97-19289X',
      description: 'Refrigerator door gasket (RT-series)',
      category: 'REF',
      unitCostUsd: 900n,
      sellPriceTzs: 3_500_000n,
      reorderLevel: 6,
      supplier: 'Dar Local Spares Ltd',
      opening: { DAR: 7, KRK: 0 },
      requiresCoreReturn: false,
    },
  ] as const;

  for (const p of SAMPLE_PARTS) {
    const part = await prisma.part.upsert({
      where: {
        companyId_partNumber: {
          companyId: company.id,
          partNumber: p.partNumber,
        },
      },
      update: {
        description: p.description,
        category: p.category,
        unitCostUsd: p.unitCostUsd,
        sellPriceTzs: p.sellPriceTzs,
        preferredSupplierId: supplierIdByName.get(p.supplier) ?? null,
        requiresCoreReturn: p.requiresCoreReturn,
        active: true,
      },
      create: {
        id: randomUUID(),
        companyId: company.id,
        partNumber: p.partNumber,
        description: p.description,
        category: p.category,
        unitCostUsd: p.unitCostUsd,
        sellPriceTzs: p.sellPriceTzs,
        preferredSupplierId: supplierIdByName.get(p.supplier) ?? null,
        requiresCoreReturn: p.requiresCoreReturn,
        createdById: admin.id,
        updatedById: admin.id,
      },
    });

    for (const [code, qty] of Object.entries(p.opening)) {
      const branchId = branchByCode.get(code);
      if (!branchId || qty <= 0) continue;

      await prisma.inventory.upsert({
        where: { branchId_partId: { branchId, partId: part.id } },
        // Non-destructive: only reorder level is refreshed on re-run; qty is
        // set on CREATE so live stock is never reset by re-seeding.
        update: { reorderLevel: p.reorderLevel, updatedById: admin.id },
        create: {
          id: randomUUID(),
          companyId: company.id,
          branchId,
          partId: part.id,
          qtyOnHand: qty,
          reorderLevel: p.reorderLevel,
          createdById: admin.id,
          updatedById: admin.id,
        },
      });

      const existing = await prisma.stockMovement.findFirst({
        where: { branchId, partId: part.id, reason: 'Opening stock (seed)' },
      });
      if (!existing) {
        await prisma.stockMovement.create({
          data: {
            id: randomUUID(),
            companyId: company.id,
            branchId,
            partId: part.id,
            movementType: 'RECEIPT',
            qty,
            reason: 'Opening stock (seed)',
            unitCost: p.unitCostUsd,
            costCurrency: 'USD',
            movedById: admin.id,
          },
        });
      }
    }
    console.log(`part:           ${part.partNumber} — ${part.description}`);
  }

  // =========================================================================
  // SCMS proposal modules
  // =========================================================================

  // --- Module 5 (§6): role financial ceilings (upsert by company+role+type) --
  for (const l of ROLE_LIMITS) {
    await prisma.roleLimit.upsert({
      where: {
        companyId_role_type: {
          companyId: company.id,
          role: l.role,
          type: l.type,
        },
      },
      update: {
        maxAmount: l.maxAmount,
        currency: l.currency,
        maxPercent: l.maxPercent,
        enabled: l.enabled,
        updatedById: admin.id,
      },
      create: {
        id: randomUUID(),
        companyId: company.id,
        role: l.role,
        type: l.type,
        maxAmount: l.maxAmount,
        currency: l.currency,
        maxPercent: l.maxPercent,
        enabled: l.enabled,
        createdById: admin.id,
        updatedById: admin.id,
      },
    });
    console.log(`role limit:     ${l.role} ${l.type} — ${l.note}`);
  }

  // --- Module 1 (§2 step 4): the cascading symptom tree ---------------------
  // Two passes are not needed: SYMPTOM_TREE is declared parents-first, so a
  // node's parent id is always already in the map when we reach it. The
  // explicit check turns a future reordering into a loud failure rather than
  // a silently orphaned branch.
  const symptomIdByCode = new Map<string, string>();
  for (const n of SYMPTOM_TREE) {
    if (n.parent && !symptomIdByCode.has(n.parent)) {
      throw new Error(
        `symptom tree seed: '${n.code}' names parent '${n.parent}' before it is defined`,
      );
    }
    const parentId = n.parent ? (symptomIdByCode.get(n.parent) ?? null) : null;
    // Depth is derived, not declared: it can only ever be the parent's depth
    // plus one, and a hand-maintained `level` column would drift.
    const level = n.parent
      ? SYMPTOM_TREE.find((x) => x.code === n.parent)?.parent
        ? 3
        : 2
      : 1;
    // A node is a LEAF when nothing else names it as a parent — computed, so
    // adding a child to a former leaf automatically demotes it.
    const isLeaf = !SYMPTOM_TREE.some((x) => x.parent === n.code);

    const node = await prisma.symptomNode.upsert({
      where: { companyId_code: { companyId: company.id, code: n.code } },
      update: {
        label: n.label,
        parentId,
        level,
        isLeaf,
        category: n.category ?? null,
        estimateAmount: n.estimateTzs ?? null,
        estimateCurrency: n.estimateTzs ? 'TZS' : null,
        estimateMinutes: n.estimateMinutes ?? null,
        sortOrder: n.sortOrder,
        active: true,
        deletedAt: null,
        updatedById: admin.id,
      },
      create: {
        id: randomUUID(),
        companyId: company.id,
        code: n.code,
        label: n.label,
        parentId,
        level,
        isLeaf,
        category: n.category ?? null,
        estimateAmount: n.estimateTzs ?? null,
        estimateCurrency: n.estimateTzs ? 'TZS' : null,
        estimateMinutes: n.estimateMinutes ?? null,
        sortOrder: n.sortOrder,
        createdById: admin.id,
        updatedById: admin.id,
      },
    });
    symptomIdByCode.set(node.code, node.id);
  }
  console.log(`symptom tree:   ${SYMPTOM_TREE.length} nodes`);

  // --- Module 1 (§2 step 3): condition-map hotspots -------------------------
  for (const z of CONDITION_ZONES) {
    await prisma.conditionZone.upsert({
      where: {
        companyId_category_code: {
          companyId: company.id,
          category: z.category,
          code: z.code,
        },
      },
      update: {
        label: z.label,
        x: new Prisma.Decimal(z.x),
        y: new Prisma.Decimal(z.y),
        face: z.face,
        sortOrder: z.sortOrder,
        active: true,
        deletedAt: null,
        updatedById: admin.id,
      },
      create: {
        id: randomUUID(),
        companyId: company.id,
        category: z.category,
        code: z.code,
        label: z.label,
        x: new Prisma.Decimal(z.x),
        y: new Prisma.Decimal(z.y),
        face: z.face,
        sortOrder: z.sortOrder,
        createdById: admin.id,
        updatedById: admin.id,
      },
    });
  }
  console.log(`condition map:  ${CONDITION_ZONES.length} hotspots`);

  // --- Module 2 (§3): QC calibration checklist ------------------------------
  for (const c of QC_CHECKLIST) {
    await prisma.qcChecklistItem.upsert({
      where: {
        companyId_category_code: {
          companyId: company.id,
          category: c.category,
          code: c.code,
        },
      },
      update: {
        label: c.label,
        help: c.help ?? null,
        requiresValue: c.requiresValue ?? false,
        requiresAttachment: c.requiresAttachment ?? false,
        blocking: c.blocking ?? true,
        sortOrder: c.sortOrder,
        active: true,
        deletedAt: null,
        updatedById: admin.id,
      },
      create: {
        id: randomUUID(),
        companyId: company.id,
        category: c.category,
        code: c.code,
        label: c.label,
        help: c.help ?? null,
        requiresValue: c.requiresValue ?? false,
        requiresAttachment: c.requiresAttachment ?? false,
        blocking: c.blocking ?? true,
        sortOrder: c.sortOrder,
        createdById: admin.id,
        updatedById: admin.id,
      },
    });
  }
  console.log(`qc checklist:   ${QC_CHECKLIST.length} items`);

  // --- Module 7 (§8): notification templates --------------------------------
  for (const t of NOTIFICATION_TEMPLATES) {
    await prisma.notificationTemplate.upsert({
      where: {
        companyId_eventCode_channel_language: {
          companyId: company.id,
          eventCode: t.eventCode,
          channel: t.channel,
          language: t.language,
        },
      },
      update: {
        subject: t.subject ?? null,
        body: t.body,
        active: true,
        deletedAt: null,
        updatedById: admin.id,
      },
      create: {
        id: randomUUID(),
        companyId: company.id,
        eventCode: t.eventCode,
        channel: t.channel,
        language: t.language,
        subject: t.subject ?? null,
        body: t.body,
        createdById: admin.id,
        updatedById: admin.id,
      },
    });
  }
  console.log(
    `templates:      ${NOTIFICATION_TEMPLATES.length} notification templates`,
  );

  console.log('Seed complete.');
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
