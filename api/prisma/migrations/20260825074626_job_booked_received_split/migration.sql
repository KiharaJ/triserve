-- Split the job intake state in two (§4.10):
--   BOOKED   — front-desk intake (what used to be called RECEIVED).
--   RECEIVED — the ASSIGNED ENGINEER's own attestation that they physically
--              have the device, inserted between BOOKED and DIAGNOSING.
--
-- workflow_states/workflow_transitions are per-company CONFIG DATA seeded by
-- prisma/seed.ts, not schema — seed.ts changes alone never reach an
-- already-seeded company, so this migration does the equivalent data surgery
-- directly, company by company, via plain code-based UPDATE/INSERT (the same
-- pattern as 20260728093505_scms_proposal_modules).
--
-- The rename is done IN PLACE (same row id), so every job currently sitting
-- in the old RECEIVED state becomes BOOKED for free — no jobs.state_id
-- rewrite needed for the common case. The one exception is handled at the
-- bottom: a job that already has engineer_received_at set (the short-lived
-- acknowledge-receipt endpoint, since retired in favour of this transition)
-- has already crossed the threshold this migration is inserting, so it is
-- moved on to the new RECEIVED row instead of staying on BOOKED.

-- 1. Rename the existing intake state RECEIVED -> BOOKED (every company).
UPDATE `workflow_states`
   SET `code` = 'BOOKED', `label` = 'Booked'
 WHERE `code` = 'RECEIVED' AND `deleted_at` IS NULL;

-- 2. Insert the new RECEIVED state (technician receipt) for every company
--    that has a BOOKED state — i.e. every company touched by step 1.
INSERT INTO `workflow_states`
  (`id`, `company_id`, `code`, `label`, `is_initial`, `is_terminal`,
   `sort_order`, `active`, `stage`, `hold_kind`, `pauses_sla`,
   `created_at`, `updated_at`)
SELECT UUID(), `company_id`, 'RECEIVED', 'Received', 0, 0,
       15, 1, 'INTAKE', 'NONE', 0,
       NOW(3), NOW(3)
  FROM `workflow_states`
 WHERE `code` = 'BOOKED' AND `deleted_at` IS NULL;

-- 3. Redirect the renamed edge (was RECEIVED->DIAGNOSING, now literally
--    BOOKED->DIAGNOSING since step 1 renamed its FROM state in place) to
--    land on the new RECEIVED state instead, and narrow its guard to just
--    the technician-acceptance check — intake-evidence now gates the NEW
--    RECEIVED->DIAGNOSING edge inserted in step 4.
UPDATE `workflow_transitions` wt
  JOIN `workflow_states` fromS
    ON fromS.`id` = wt.`from_state_id` AND fromS.`code` = 'BOOKED'
  JOIN `workflow_states` oldTo
    ON oldTo.`id` = wt.`to_state_id` AND oldTo.`code` = 'DIAGNOSING'
  JOIN `workflow_states` newTo
    ON newTo.`company_id` = wt.`company_id` AND newTo.`code` = 'RECEIVED'
   AND newTo.`deleted_at` IS NULL
   SET wt.`to_state_id` = newTo.`id`,
       wt.`guard_code` = 'engineer_skill_match'
 WHERE wt.`deleted_at` IS NULL;

-- 4. Insert the new RECEIVED -> DIAGNOSING edge (intake-evidence gate).
INSERT INTO `workflow_transitions`
  (`id`, `company_id`, `from_state_id`, `to_state_id`,
   `required_permission`, `requires_approval`, `guard_code`,
   `created_at`, `updated_at`)
SELECT UUID(), r.`company_id`, r.`id`, d.`id`,
       'job.transition', 0, 'intake_evidence_complete',
       NOW(3), NOW(3)
  FROM `workflow_states` r
  JOIN `workflow_states` d
    ON d.`company_id` = r.`company_id` AND d.`code` = 'DIAGNOSING'
   AND d.`deleted_at` IS NULL
 WHERE r.`code` = 'RECEIVED' AND r.`deleted_at` IS NULL;

-- 5. Redirect the "step back one stage" reverse edge (was
--    DIAGNOSING->RECEIVED, now DIAGNOSING->BOOKED after step 1's rename) so
--    stepping back from DIAGNOSING lands on "received, not yet diagnosing"
--    rather than skipping all the way back to "booked, not yet received".
UPDATE `workflow_transitions` wt
  JOIN `workflow_states` fromS
    ON fromS.`id` = wt.`from_state_id` AND fromS.`code` = 'DIAGNOSING'
  JOIN `workflow_states` oldTo
    ON oldTo.`id` = wt.`to_state_id` AND oldTo.`code` = 'BOOKED'
  JOIN `workflow_states` newTo
    ON newTo.`company_id` = wt.`company_id` AND newTo.`code` = 'RECEIVED'
   AND newTo.`deleted_at` IS NULL
   SET wt.`to_state_id` = newTo.`id`
 WHERE wt.`deleted_at` IS NULL;

-- 6. Insert the new reverse edge RECEIVED -> BOOKED (undo an accidental
--    "received" click — same "step back one stage" convention).
INSERT INTO `workflow_transitions`
  (`id`, `company_id`, `from_state_id`, `to_state_id`,
   `required_permission`, `requires_approval`, `guard_code`,
   `created_at`, `updated_at`)
SELECT UUID(), r.`company_id`, r.`id`, b.`id`,
       'job.transition', 0, NULL,
       NOW(3), NOW(3)
  FROM `workflow_states` r
  JOIN `workflow_states` b
    ON b.`company_id` = r.`company_id` AND b.`code` = 'BOOKED'
   AND b.`deleted_at` IS NULL
 WHERE r.`code` = 'RECEIVED' AND r.`deleted_at` IS NULL;

-- 7. Insert the new edge RECEIVED -> CANCELLED (a job may still be cancelled
--    after the engineer has the device but before diagnosis starts).
INSERT INTO `workflow_transitions`
  (`id`, `company_id`, `from_state_id`, `to_state_id`,
   `required_permission`, `requires_approval`, `guard_code`,
   `created_at`, `updated_at`)
SELECT UUID(), r.`company_id`, r.`id`, c.`id`,
       'job.transition', 0, NULL,
       NOW(3), NOW(3)
  FROM `workflow_states` r
  JOIN `workflow_states` c
    ON c.`company_id` = r.`company_id` AND c.`code` = 'CANCELLED'
   AND c.`deleted_at` IS NULL
 WHERE r.`code` = 'RECEIVED' AND r.`deleted_at` IS NULL;

-- 8. A job already stamped engineer_received_at (via the short-lived
--    acknowledge-receipt endpoint) has already crossed the threshold this
--    migration models as a state — move it off BOOKED onto the new RECEIVED
--    row rather than leaving it looking un-received.
UPDATE `jobs` j
  JOIN `workflow_states` booked
    ON booked.`id` = j.`state_id` AND booked.`code` = 'BOOKED'
  JOIN `workflow_states` received
    ON received.`company_id` = j.`company_id` AND received.`code` = 'RECEIVED'
   AND received.`deleted_at` IS NULL
   SET j.`state_id` = received.`id`
 WHERE j.`engineer_received_at` IS NOT NULL;
