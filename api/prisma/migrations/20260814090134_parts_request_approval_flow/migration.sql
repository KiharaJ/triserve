-- AlterTable
ALTER TABLE `approval_rules` MODIFY `type` ENUM('PRICE_OVERRIDE', 'REFUND', 'INVENTORY_ADJUSTMENT', 'STOCK_TRANSFER', 'PURCHASE_ORDER', 'WARRANTY_CANCELLATION', 'INVOICE_VOID', 'REOPEN_JOB', 'LARGE_CASH_REFUND', 'MANUAL_JOURNAL', 'CLAIM_SPLIT_MISMATCH', 'OW_REPAIR_WITHOUT_QUOTE', 'DUPLICATE_WARRANTY_CLAIM', 'JOB_COVERAGE_CHANGE', 'BER_CERTIFICATION', 'DEVICE_SWAP', 'WRITE_OFF', 'PARTS_REQUEST') NOT NULL;

-- AlterTable
ALTER TABLE `approvals` MODIFY `type` ENUM('PRICE_OVERRIDE', 'REFUND', 'INVENTORY_ADJUSTMENT', 'STOCK_TRANSFER', 'PURCHASE_ORDER', 'WARRANTY_CANCELLATION', 'INVOICE_VOID', 'REOPEN_JOB', 'LARGE_CASH_REFUND', 'MANUAL_JOURNAL', 'CLAIM_SPLIT_MISMATCH', 'OW_REPAIR_WITHOUT_QUOTE', 'DUPLICATE_WARRANTY_CLAIM', 'JOB_COVERAGE_CHANGE', 'BER_CERTIFICATION', 'DEVICE_SWAP', 'WRITE_OFF', 'PARTS_REQUEST') NOT NULL;

-- AlterTable
ALTER TABLE `job_parts` ADD COLUMN `acknowledged_at` DATETIME(3) NULL,
    ADD COLUMN `acknowledged_by` CHAR(36) NULL,
    ADD COLUMN `approval_id` CHAR(36) NULL,
    ADD COLUMN `approved_at` DATETIME(3) NULL,
    ADD COLUMN `approved_by` CHAR(36) NULL,
    ADD COLUMN `rejected_at` DATETIME(3) NULL,
    ADD COLUMN `rejected_by` CHAR(36) NULL,
    ADD COLUMN `rejection_reason` VARCHAR(500) NULL,
    ADD COLUMN `request_note` VARCHAR(500) NULL,
    ADD COLUMN `requested_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    ADD COLUMN `requested_by` CHAR(36) NULL,
    MODIFY `status` ENUM('REQUESTED', 'RESERVED', 'ISSUED', 'ACKNOWLEDGED', 'CONSUMED', 'CANCELLED', 'REJECTED') NOT NULL DEFAULT 'REQUESTED',
    MODIFY `reserved_at` DATETIME(3) NULL;

-- Backfill: every line that existed before the request flow was reserved the
-- moment it was created, so its reservation time IS its request time. Taken
-- from the row rather than the column default on purpose — the DB host clock
-- runs behind application time, so CURRENT_TIMESTAMP would stamp these rows
-- with a date that never happened.
UPDATE `job_parts` SET `requested_at` = `reserved_at` WHERE `reserved_at` IS NOT NULL;

-- Pre-existing lines were created under the old flow, where adding a line WAS
-- the approval. Nothing is pending for them, so they keep their terminal
-- status; this only makes their history readable.
UPDATE `job_parts` SET `approved_at` = `reserved_at`, `approved_by` = `created_by`
WHERE `reserved_at` IS NOT NULL AND `status` IN ('RESERVED', 'ISSUED', 'CONSUMED');

-- AddForeignKey
ALTER TABLE `job_parts` ADD CONSTRAINT `job_parts_requested_by_fkey` FOREIGN KEY (`requested_by`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `job_parts` ADD CONSTRAINT `job_parts_approved_by_fkey` FOREIGN KEY (`approved_by`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `job_parts` ADD CONSTRAINT `job_parts_rejected_by_fkey` FOREIGN KEY (`rejected_by`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `job_parts` ADD CONSTRAINT `job_parts_acknowledged_by_fkey` FOREIGN KEY (`acknowledged_by`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
