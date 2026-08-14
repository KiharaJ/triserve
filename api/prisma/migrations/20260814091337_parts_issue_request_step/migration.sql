-- AlterTable
ALTER TABLE `job_parts` ADD COLUMN `issue_requested_at` DATETIME(3) NULL,
    ADD COLUMN `issue_requested_by` CHAR(36) NULL,
    MODIFY `status` ENUM('REQUESTED', 'ISSUE_REQUESTED', 'RESERVED', 'ISSUED', 'ACKNOWLEDGED', 'CONSUMED', 'CANCELLED', 'REJECTED') NOT NULL DEFAULT 'REQUESTED';

-- AddForeignKey
ALTER TABLE `job_parts` ADD CONSTRAINT `job_parts_issue_requested_by_fkey` FOREIGN KEY (`issue_requested_by`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
