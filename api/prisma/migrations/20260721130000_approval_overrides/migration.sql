-- Admin overrides of the warranty/repair guards (§4.11 / §4.7).
--
-- Four guards that today fail hard now have a documented way through: the
-- operator requests an override, an approver decides it, and the ORIGINAL
-- action is retried carrying the approval id. That is the pattern the
-- approvals framework was designed for (see ApprovalsService's doc comment) —
-- request, decide, then re-attempt.
--
--   CLAIM_SPLIT_MISMATCH     labour+parts+shipping+tax != the claim total
--   OW_REPAIR_WITHOUT_QUOTE  start a chargeable repair with no accepted quote
--   DUPLICATE_WARRANTY_CLAIM a second claim against an already-claimed job
--   JOB_COVERAGE_CHANGE      re-rule who pays after money has been committed

-- AlterTable: extend the approval type vocabulary.
ALTER TABLE `approvals` MODIFY `type` ENUM('PRICE_OVERRIDE', 'REFUND', 'INVENTORY_ADJUSTMENT', 'STOCK_TRANSFER', 'PURCHASE_ORDER', 'WARRANTY_CANCELLATION', 'INVOICE_VOID', 'REOPEN_JOB', 'LARGE_CASH_REFUND', 'MANUAL_JOURNAL', 'CLAIM_SPLIT_MISMATCH', 'OW_REPAIR_WITHOUT_QUOTE', 'DUPLICATE_WARRANTY_CLAIM', 'JOB_COVERAGE_CHANGE') NOT NULL;

ALTER TABLE `approval_rules` MODIFY `type` ENUM('PRICE_OVERRIDE', 'REFUND', 'INVENTORY_ADJUSTMENT', 'STOCK_TRANSFER', 'PURCHASE_ORDER', 'WARRANTY_CANCELLATION', 'INVOICE_VOID', 'REOPEN_JOB', 'LARGE_CASH_REFUND', 'MANUAL_JOURNAL', 'CLAIM_SPLIT_MISMATCH', 'OW_REPAIR_WITHOUT_QUOTE', 'DUPLICATE_WARRANTY_CLAIM', 'JOB_COVERAGE_CHANGE') NOT NULL;

-- AlterTable: an APPROVED override is SINGLE USE.
--
-- Without this, one approved override is a permanent key: the same approval
-- id could be replayed on every later attempt, so a one-off "yes" would
-- silently become standing permission. `consumed_at` is stamped by the action
-- that spends it, and the partial unique index is unnecessary because
-- consumption is guarded by a conditional UPDATE (consumed_at IS NULL).
ALTER TABLE `approvals`
    ADD COLUMN `consumed_at` DATETIME(3) NULL,
    ADD COLUMN `consumed_by` CHAR(36) NULL;

-- AddForeignKey
ALTER TABLE `approvals` ADD CONSTRAINT `approvals_consumed_by_fkey` FOREIGN KEY (`consumed_by`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- CreateIndex: finding an unspent override for a given entity.
CREATE INDEX `approvals_company_id_type_status_consumed_at_idx` ON `approvals`(`company_id`, `type`, `status`, `consumed_at`);

-- AlterTable: spending an override is its own audited event — distinct from
-- APPROVE (the decision) because the decision and the use can be minutes or
-- days apart, by different people.
ALTER TABLE `audit_log` MODIFY `action` ENUM('CREATE', 'UPDATE', 'DELETE', 'TRANSITION', 'LOGIN', 'APPROVE', 'REJECT', 'OVERRIDE_USED') NOT NULL;
