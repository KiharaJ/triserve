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
  // Task 2.1 (§4.4): the spare-parts CATALOGUE (part numbers, costs, reorder
  // config) — company-level like models. Reading stock levels is
  // 'inventory.read'; editing the catalogue itself is 'part.manage'.
  parts: ['part.read', 'part.manage'],
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
    'supplier.read',
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
  // Task 1.4 (§4.12/E4): signature + before/after photo capture.
  attachments: ['attachment.create', 'attachment.read', 'attachment.delete'],
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

/**
 * The seven BUILT-IN role names. Companies may additionally define their own
 * custom roles (E17b) whose keys are arbitrary uppercase slugs — those are NOT
 * in this union, so anything that must accept any role key is typed `string`
 * (a role KEY), and `RoleName` is reserved for the built-ins that carry static
 * defaults, labels and descriptions here.
 */
export type RoleName = (typeof USER_ROLES)[number];

/** Alias that reads intentionally at custom-role call sites. */
export const BUILTIN_ROLES = USER_ROLES;

/** True when `key` is one of the seven built-in roles. */
export function isBuiltinRole(key: string): key is RoleName {
  return (USER_ROLES as readonly string[]).includes(key);
}

/**
 * Custom role keys: 2–50 chars, UPPER_SNAKE (uppercase letters, digits,
 * underscores), starting with a letter. Built-in keys follow the same shape,
 * so this validates both; uniqueness (incl. not colliding with a built-in) is
 * enforced by the API against the company's roles.
 */
export const ROLE_KEY_PATTERN = /^[A-Z][A-Z0-9_]{1,49}$/;

/** True when `key` is a syntactically valid role key. */
export function isValidRoleKey(key: string): boolean {
  return ROLE_KEY_PATTERN.test(key);
}

/** Derive a candidate role key from a free-text label ("Front Desk" → "FRONT_DESK"). */
export function roleKeyFromLabel(label: string): string {
  return label
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/^([0-9])/, '_$1')
    .slice(0, 50);
}

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
    'part.read',
    'part.manage',
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
    'supplier.read',
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
    // Task 1.4 (§4.12): branch managers capture, view AND remove attachments.
    'attachment.create',
    'attachment.read',
    'attachment.delete',
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
    'part.read',
    'inventory.read',
    'pos.sell',
    'invoice.create',
    'invoice.read',
    'payment.capture',
    'discount.apply',
    'approval.request',
    // Task 1.4 (§4.12): front desk captures the customer signature +
    // before-photos at intake.
    'attachment.create',
    'attachment.read',
  ],

  TECHNICIAN: [
    'job.read',
    'job.update',
    'job.transition',
    'job.transition.repair',
    'device.read',
    'model.read',
    'part.read',
    'inventory.read',
    'inventory.reserve',
    'inventory.consume',
    'approval.request',
    // Task 1.4 (§4.12): bench captures after-photos on completion.
    'attachment.create',
    'attachment.read',
  ],

  STOREKEEPER: [
    'part.read',
    'part.manage',
    'inventory.read',
    'inventory.reserve',
    'inventory.adjust',
    'inventory.transfer',
    'inventory.count',
    'po.create',
    'po.read',
    'grn.receive',
    'supplier.read',
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
    'supplier.read',
    'part.read',
    'inventory.read',
    'job.read',
    'customer.read',
    'device.read',
    'warranty.claim.read',
  ],
};

/**
 * True when `role` holds `permission` under the DEFAULT matrix.
 * SUPER_ADMIN always passes. A custom role (not in the built-in map) has NO
 * static default — its grants live entirely in the per-company overrides — so
 * this returns false for it (callers resolve the real answer via overrides).
 */
export function roleHasPermission(
  role: string,
  permission: Permission,
): boolean {
  if (role === 'SUPER_ADMIN') return true;
  return (ROLE_PERMISSIONS[role as RoleName] ?? []).includes(permission);
}

// ---------------------------------------------------------------------------
// Editable per-company matrix (E17)
//
// Companies may tune each role's permissions away from the defaults above.
// The API persists only the DELTA from the default (a set of
// {role, permission, granted} overrides) and resolves the *effective* matrix
// as `default XOR overrides`, so a permission added to the catalogue later is
// automatically inherited by every role until a company explicitly overrides
// it. SUPER_ADMIN is never editable — it always holds every permission, which
// guarantees a company can never lock every admin out of its own tenant.
// ---------------------------------------------------------------------------

/** Every built-in role a company MAY re-scope (all but the SUPER_ADMIN). */
export const EDITABLE_ROLES: readonly RoleName[] = USER_ROLES.filter(
  (r) => r !== 'SUPER_ADMIN',
);

/**
 * True when a company may edit this role's permission set. Only SUPER_ADMIN is
 * locked (it always holds every permission). All other built-in roles AND any
 * custom role are editable.
 */
export function isRoleEditable(role: string): boolean {
  return role !== 'SUPER_ADMIN';
}

/** The default permission set for a role KEY (empty for a custom role). */
export function defaultPermissionsFor(role: string): readonly Permission[] {
  if (role === 'SUPER_ADMIN') return ALL_PERMISSIONS;
  return ROLE_PERMISSIONS[role as RoleName] ?? [];
}

/** One persisted deviation from the default matrix for a single company. */
export interface PermissionOverride {
  /** A role KEY — a built-in or a custom role. */
  role: string;
  permission: Permission;
  /** true = grant on top of the default, false = revoke from the default. */
  granted: boolean;
}

/**
 * Resolve a role's EFFECTIVE permission set from its default plus a company's
 * overrides. SUPER_ADMIN always resolves to every permission. A custom role
 * has an empty default, so its grants come entirely from `granted` overrides.
 * Overrides for permissions no longer in the catalogue are ignored.
 */
export function resolveEffectivePermissions(
  role: string,
  overrides: readonly PermissionOverride[],
): Permission[] {
  if (role === 'SUPER_ADMIN') return [...ALL_PERMISSIONS];

  const effective = new Set<Permission>(defaultPermissionsFor(role));
  const known = new Set<Permission>(ALL_PERMISSIONS);
  for (const o of overrides) {
    if (o.role !== role || !known.has(o.permission)) continue;
    if (o.granted) effective.add(o.permission);
    else effective.delete(o.permission);
  }
  // Preserve the catalogue order for a stable, groupable response.
  return ALL_PERMISSIONS.filter((p) => effective.has(p));
}

/** Human-readable label for each permission domain (the PERMISSIONS keys). */
export const PERMISSION_DOMAIN_LABELS: Record<
  keyof typeof PERMISSIONS,
  string
> = {
  jobs: 'Jobs & repairs',
  parts: 'Parts catalogue',
  inventory: 'Inventory & stock',
  procurement: 'Procurement',
  pos: 'Point of sale',
  warranty: 'Warranty',
  approvals: 'Approvals',
  accounting: 'Accounting',
  customers: 'Customers',
  devices: 'Devices',
  models: 'Device models',
  users: 'Users & access',
  reports: 'Reports',
  config: 'Configuration',
  audit: 'Audit',
  attachments: 'Attachments',
};

/** Short human labels for every permission, for the matrix editor. */
export const PERMISSION_LABELS: Record<Permission, string> = {
  'job.create': 'Book jobs',
  'job.read': 'View jobs',
  'job.update': 'Edit jobs',
  'job.assign': 'Assign engineers',
  'job.transition': 'Move jobs (front desk)',
  'job.transition.repair': 'Move jobs (bench/repair)',
  'job.transition.dispatch': 'Move jobs (dispatch/handover)',
  'job.reopen': 'Reopen closed jobs',
  'part.read': 'View parts catalogue',
  'part.manage': 'Manage parts catalogue',
  'inventory.read': 'View stock levels',
  'inventory.reserve': 'Reserve stock',
  'inventory.consume': 'Consume stock',
  'inventory.adjust': 'Adjust stock',
  'inventory.transfer': 'Transfer stock',
  'inventory.count': 'Stock counts',
  'po.create': 'Raise purchase orders',
  'po.read': 'View purchase orders',
  'po.approve': 'Approve purchase orders',
  'grn.receive': 'Receive deliveries (GRN)',
  'supplier.read': 'View suppliers',
  'supplier.manage': 'Manage suppliers',
  'pos.sell': 'Sell at POS',
  'invoice.create': 'Create invoices',
  'invoice.read': 'View invoices',
  'invoice.void': 'Void invoices',
  'payment.capture': 'Capture payments',
  'payment.refund': 'Refund payments',
  'discount.apply': 'Apply discounts',
  'warranty.claim.create': 'Create warranty claims',
  'warranty.claim.read': 'View warranty claims',
  'warranty.claim.submit': 'Submit warranty claims',
  'warranty.claim.reconcile': 'Reconcile warranty claims',
  'warranty.claim.cancel': 'Cancel warranty claims',
  'approval.request': 'Request approvals',
  'approval.decide': 'Decide approvals',
  'accounting.read': 'View accounting',
  'accounting.post': 'Post journal entries',
  'accounting.close': 'Close accounting periods',
  'customer.create': 'Create customers',
  'customer.read': 'View customers',
  'customer.update': 'Edit customers',
  'device.create': 'Create devices',
  'device.read': 'View devices',
  'device.update': 'Edit devices',
  'model.read': 'View device models',
  'model.manage': 'Manage device models',
  'user.read': 'View users & roles',
  'user.manage': 'Manage users & roles',
  'report.view.branch': 'Branch reports',
  'report.view.group': 'Group reports',
  'report.view.finance': 'Finance reports',
  'config.read': 'View configuration',
  'config.manage': 'Manage configuration',
  'audit.read': 'View audit log',
  'attachment.create': 'Upload attachments',
  'attachment.read': 'View attachments',
  'attachment.delete': 'Delete attachments',
};

/** Display name for each role. */
export const ROLE_LABELS: Record<RoleName, string> = {
  SUPER_ADMIN: 'Super Admin',
  BRANCH_MANAGER: 'Branch Manager',
  SERVICE_ADVISOR: 'Service Advisor',
  TECHNICIAN: 'Technician',
  STOREKEEPER: 'Storekeeper',
  WARRANTY_CLERK: 'Warranty Clerk',
  ACCOUNTANT: 'Accountant',
};

/** One-line description of each role, for the roles admin screen. */
export const ROLE_DESCRIPTIONS: Record<RoleName, string> = {
  SUPER_ADMIN: 'Full access to every area — cannot be restricted.',
  BRANCH_MANAGER: 'Runs a branch: approvals, staff, stock and reporting.',
  SERVICE_ADVISOR: 'Front desk: customers, intake, invoicing and handover.',
  TECHNICIAN: 'Bench: works on and moves assigned repair jobs.',
  STOREKEEPER: 'Parts and stock: catalogue, counts, transfers and receiving.',
  WARRANTY_CLERK: 'Handles warranty claims end to end.',
  ACCOUNTANT: 'Group-wide finance: ledger, posting and reports.',
};

// -- Wire contracts shared by the roles admin endpoint & UI ------------------

/** One role's resolved permission state (GET /roles). */
export interface RoleMatrixEntry {
  /** Role KEY — built-in (e.g. "TECHNICIAN") or a custom slug. */
  role: string;
  label: string;
  description: string;
  /** true for the seven built-ins, false for company-defined custom roles. */
  is_system: boolean;
  /** Whether this role's permission set may be edited (false only for SUPER_ADMIN). */
  editable: boolean;
  /** Whether this role may be deleted (custom, not held by any user). */
  deletable: boolean;
  /** Effective permissions after applying this company's overrides. */
  effective: Permission[];
  /** The default permissions for this role (empty for a custom role). */
  default: Permission[];
  /** Permissions whose effective grant differs from the default. */
  overridden: Permission[];
  /** How many active users currently hold this role. */
  user_count: number;
}

/** GET /roles response. */
export interface RolesMatrixResponse {
  roles: RoleMatrixEntry[];
}

/** PUT /roles/{role}/permissions body — the desired effective grant set. */
export interface UpdateRolePermissionsBody {
  permissions: Permission[];
}

/** POST /roles body — create a custom role. */
export interface CreateRoleBody {
  /** Optional explicit key (UPPER_SNAKE); derived from `label` when omitted. */
  key?: string;
  label: string;
  description?: string;
  /** Seed the new role's permissions with these (defaults to none). */
  permissions?: Permission[];
  /** Or clone the effective permissions of an existing role key. */
  clone_from?: string;
}

/** PATCH /roles/{role} body — rename / re-describe a custom role. */
export interface UpdateRoleBody {
  label?: string;
  description?: string;
}
