-- "Step back one stage" reverse workflow edges (data migration).
--
-- seed.ts creates these for NEW companies, but the deploy pipeline runs
-- `prisma migrate deploy` (not the seed), so existing companies need the
-- edges backfilled here. For every company we resolve the from/to states by
-- CODE and insert the edge only when it does not already exist (idempotent,
-- and safe against the @@unique(company_id, from_state_id, to_state_id) — the
-- NOT EXISTS check ignores deleted_at so a soft-deleted duplicate can't cause
-- a unique violation).
--
-- Scope: the active repair path only. Reopening a terminal state or reversing
-- a dispatch is intentionally excluded. QC->IN_REPAIR already exists as rework.

-- DIAGNOSING -> RECEIVED  (general move: 'job.transition')
INSERT INTO `workflow_transitions`
  (`id`, `company_id`, `from_state_id`, `to_state_id`, `required_permission`, `requires_approval`, `guard_code`, `created_at`, `updated_at`)
SELECT UUID(), fs.`company_id`, fs.`id`, ts.`id`, 'job.transition', 0, NULL, NOW(3), NOW(3)
FROM `workflow_states` fs
JOIN `workflow_states` ts ON ts.`company_id` = fs.`company_id` AND ts.`code` = 'RECEIVED'
WHERE fs.`code` = 'DIAGNOSING'
  AND NOT EXISTS (
    SELECT 1 FROM `workflow_transitions` wt
    WHERE wt.`company_id` = fs.`company_id` AND wt.`from_state_id` = fs.`id` AND wt.`to_state_id` = ts.`id`
  );

-- AWAITING_CUSTOMER_APPROVAL -> DIAGNOSING  ('job.transition')
INSERT INTO `workflow_transitions`
  (`id`, `company_id`, `from_state_id`, `to_state_id`, `required_permission`, `requires_approval`, `guard_code`, `created_at`, `updated_at`)
SELECT UUID(), fs.`company_id`, fs.`id`, ts.`id`, 'job.transition', 0, NULL, NOW(3), NOW(3)
FROM `workflow_states` fs
JOIN `workflow_states` ts ON ts.`company_id` = fs.`company_id` AND ts.`code` = 'DIAGNOSING'
WHERE fs.`code` = 'AWAITING_CUSTOMER_APPROVAL'
  AND NOT EXISTS (
    SELECT 1 FROM `workflow_transitions` wt
    WHERE wt.`company_id` = fs.`company_id` AND wt.`from_state_id` = fs.`id` AND wt.`to_state_id` = ts.`id`
  );

-- AWAITING_PARTS -> DIAGNOSING  ('job.transition')
INSERT INTO `workflow_transitions`
  (`id`, `company_id`, `from_state_id`, `to_state_id`, `required_permission`, `requires_approval`, `guard_code`, `created_at`, `updated_at`)
SELECT UUID(), fs.`company_id`, fs.`id`, ts.`id`, 'job.transition', 0, NULL, NOW(3), NOW(3)
FROM `workflow_states` fs
JOIN `workflow_states` ts ON ts.`company_id` = fs.`company_id` AND ts.`code` = 'DIAGNOSING'
WHERE fs.`code` = 'AWAITING_PARTS'
  AND NOT EXISTS (
    SELECT 1 FROM `workflow_transitions` wt
    WHERE wt.`company_id` = fs.`company_id` AND wt.`from_state_id` = fs.`id` AND wt.`to_state_id` = ts.`id`
  );

-- IN_REPAIR -> AWAITING_PARTS  (bench move: 'job.transition.repair')
INSERT INTO `workflow_transitions`
  (`id`, `company_id`, `from_state_id`, `to_state_id`, `required_permission`, `requires_approval`, `guard_code`, `created_at`, `updated_at`)
SELECT UUID(), fs.`company_id`, fs.`id`, ts.`id`, 'job.transition.repair', 0, NULL, NOW(3), NOW(3)
FROM `workflow_states` fs
JOIN `workflow_states` ts ON ts.`company_id` = fs.`company_id` AND ts.`code` = 'AWAITING_PARTS'
WHERE fs.`code` = 'IN_REPAIR'
  AND NOT EXISTS (
    SELECT 1 FROM `workflow_transitions` wt
    WHERE wt.`company_id` = fs.`company_id` AND wt.`from_state_id` = fs.`id` AND wt.`to_state_id` = ts.`id`
  );

-- READY -> QC  (bench move: 'job.transition.repair')
INSERT INTO `workflow_transitions`
  (`id`, `company_id`, `from_state_id`, `to_state_id`, `required_permission`, `requires_approval`, `guard_code`, `created_at`, `updated_at`)
SELECT UUID(), fs.`company_id`, fs.`id`, ts.`id`, 'job.transition.repair', 0, NULL, NOW(3), NOW(3)
FROM `workflow_states` fs
JOIN `workflow_states` ts ON ts.`company_id` = fs.`company_id` AND ts.`code` = 'QC'
WHERE fs.`code` = 'READY'
  AND NOT EXISTS (
    SELECT 1 FROM `workflow_transitions` wt
    WHERE wt.`company_id` = fs.`company_id` AND wt.`from_state_id` = fs.`id` AND wt.`to_state_id` = ts.`id`
  );
