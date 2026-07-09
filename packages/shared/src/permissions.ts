/**
 * Permission matrix (Task 0.3 / E18, DESIGN.md §3).
 *
 * Authorization is expressed as fine-grained ACTION strings ("permissions"),
 * grouped by domain, rather than coarse role checks. The API enforces them
 * server-side per endpoint via `@RequirePermissions(...)`; the web app reads
 * the same map to show/hide UI affordances (never as the real gate).
 *
 * EXTENSION POINT (E17): `ROLE_PERMISSIONS` below is the *default* matrix.
 * The design makes the role × action matrix editable per company; when that
 * lands, a DB-backed resolver will load per-company overrides and fall back
 * to these defaults. Keep every permission string here so both sides share
 * one vocabulary.
 */

/** All permission actions, grouped by domain. Add new actions here first. */
export const PERMISSIONS = {
  jobs: [
    'job.create',
    'job.read',
    'job.update',
    'job.assign',
    'job.transition',
    // Task 1.2 (§4.10/E7): granular workflow-transition permissions used by
    // the seeded default workflow (workflow_transitions.required_permission).
    // 'job.transition' gates general front-desk moves (intake, diagnosis
    // routing, cancellation); '.repair' gates bench moves (→IN_REPAIR, →QC,
    // QC→READY) held by TECHNICIAN + managers; '.dispatch' gates handover
    // moves (READY→DISPATCHED, DISPATCHED→CLOSED) held by SERVICE_ADVISOR
    // (front desk) + managers. Technicians deliberately CANNOT dispatch;
    // advisors deliberately cannot perform bench moves.
    'job.transition.repair',
    'job.transition.dispatch',
    'job.reopen',
  ],
  inventory: [
    'inventory.read',
    'inventory.reserve',
    'inventory.consume',
    'inventory.adjust',
    'inventory.transfer',
    'inventory.count',
  ],
  procurement: [
    'po.create',
    'po.read',
    'po.approve',
    'grn.receive',
    'supplier.manage',
  ],
  pos: [
    'pos.sell',
    'invoice.create',
    'invoice.read',
    'invoice.void',
    'payment.capture',
    'payment.refund',
    'discount.apply',
  ],
  warranty: [
    'warranty.claim.create',
    'warranty.claim.read',
    'warranty.claim.submit',
    'warranty.claim.reconcile',
    'warranty.claim.cancel',
  ],
  approvals: ['approval.request', 'approval.decide'],
  accounting: ['accounting.read', 'accounting.post', 'accounting.close'],
  customers: ['customer.create', 'customer.read', 'customer.update'],
  // Task 1.1 (§4.2): devices are created/edited at the front desk alongside
  // customers; models are a company-level lookup managed by admins/managers.
  devices: ['device.create', 'device.read', 'device.update'],
  models: ['model.read', 'model.manage'],
  users: ['user.read', 'user.manage'],
  reports: ['report.view.branch', 'report.view.group', 'report.view.finance'],
  config: ['config.read', 'config.manage'],
  audit: ['audit.read'],
} as const;

/** Union of every permission action string, e.g. 'job.transition'. */
export type Permission =
  (typeof PERMISSIONS)[keyof typeof PERMISSIONS][number];

/** Flat list of every permission (SUPER_ADMIN's grant). */
export const ALL_PERMISSIONS: readonly Permission[] = Object.values(
  PERMISSIONS,
).flat();

/**
 * Role names — string values match the API's `users.role` MySQL ENUM
 * (and the Prisma `UserRole` enum) exactly, so `ROLE_PERMISSIONS[user.role]`
 * works on both sides without importing @prisma/client here.
 */
export const USER_ROLES = [
  'SUPER_ADMIN',
  'BRANCH_MANAGER',
  'SERVICE_ADVISOR',
  'TECHNICIAN',
  'STOREKEEPER',
  'WARRANTY_CLERK',
  'ACCOUNTANT',
] as const;

export type RoleName = (typeof USER_ROLES)[number];

/**
 * Default role → permissions map (DESIGN.md §3).
 *
 * - SUPER_ADMIN holds every permission.
 * - Roles that must *request* gated actions (discounts, adjustments, PO
 *   above limit, claim cancellation…) get 'approval.request'; the Branch
 *   Manager is the approver ('approval.decide', E8).
 * - ACCOUNTANT is group-scoped read-mostly + posting/closing books.
 */
export const ROLE_PERMISSIONS: Readonly<
  Record<RoleName, readonly Permission[]>
> = {
  SUPER_ADMIN: ALL_PERMISSIONS,

  BRANCH_MANAGER: [
    'job.create',
    'job.read',
    'job.update',
    'job.assign',
    'job.transition',
    'job.transition.repair',
    'job.transition.dispatch',
    'job.reopen',
    'inventory.read',
    'inventory.reserve',
    'inventory.consume',
    'inventory.adjust',
    'inventory.transfer',
    'inventory.count',
    'po.create',
    'po.read',
    'po.approve',
    'grn.receive',
    'supplier.manage',
    'pos.sell',
    'invoice.create',
    'invoice.read',
    'invoice.void',
    'payment.capture',
    'payment.refund',
    'discount.apply',
    'warranty.claim.read',
    'approval.request',
    'approval.decide',
    'customer.create',
    'customer.read',
    'customer.update',
    'device.create',
    'device.read',
    'device.update',
    'model.read',
    'model.manage',
    'user.read',
    'report.view.branch',
    'config.read',
    'audit.read',
  ],

  SERVICE_ADVISOR: [
    'customer.create',
    'customer.read',
    'customer.update',
    'device.create',
    'device.read',
    'device.update',
    'model.read',
    'job.create',
    'job.read',
    'job.update',
    'job.transition',
    'job.transition.dispatch',
    'inventory.read',
    'pos.sell',
    'invoice.create',
    'invoice.read',
    'payment.capture',
    'discount.apply',
    'approval.request',
  ],

  TECHNICIAN: [
    'job.read',
    'job.update',
    'job.transition',
    'job.transition.repair',
    'device.read',
    'model.read',
    'inventory.read',
    'inventory.reserve',
    'inventory.consume',
    'approval.request',
  ],

  STOREKEEPER: [
    'inventory.read',
    'inventory.reserve',
    'inventory.adjust',
    'inventory.transfer',
    'inventory.count',
    'po.create',
    'po.read',
    'grn.receive',
    'supplier.manage',
    'approval.request',
  ],

  WARRANTY_CLERK: [
    'warranty.claim.create',
    'warranty.claim.read',
    'warranty.claim.submit',
    'warranty.claim.reconcile',
    'warranty.claim.cancel',
    'job.read',
    'customer.read',
    'device.read',
    'model.read',
    'approval.request',
  ],

  ACCOUNTANT: [
    'accounting.read',
    'accounting.post',
    'accounting.close',
    'report.view.branch',
    'report.view.group',
    'report.view.finance',
    'audit.read',
    'invoice.read',
    'po.read',
    'inventory.read',
    'job.read',
    'customer.read',
    'device.read',
    'warranty.claim.read',
  ],
};

/**
 * True when `role` holds `permission` under the DEFAULT matrix.
 * SUPER_ADMIN always passes.
 */
export function roleHasPermission(
  role: RoleName,
  permission: Permission,
): boolean {
  if (role === 'SUPER_ADMIN') return true;
  return ROLE_PERMISSIONS[role].includes(permission);
}
