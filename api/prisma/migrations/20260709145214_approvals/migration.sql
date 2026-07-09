-- CreateTable
CREATE TABLE `approvals` (
    `id` CHAR(36) NOT NULL,
    `company_id` CHAR(36) NOT NULL,
    `branch_id` CHAR(36) NOT NULL,
    `type` ENUM('PRICE_OVERRIDE', 'REFUND', 'INVENTORY_ADJUSTMENT', 'STOCK_TRANSFER', 'PURCHASE_ORDER', 'WARRANTY_CANCELLATION', 'INVOICE_VOID', 'REOPEN_JOB', 'LARGE_CASH_REFUND', 'MANUAL_JOURNAL') NOT NULL,
    `ref_type` VARCHAR(100) NULL,
    `ref_id` CHAR(36) NULL,
    `payload_json` JSON NULL,
    `requested_by` CHAR(36) NOT NULL,
    `approved_by` CHAR(36) NULL,
    `status` ENUM('PENDING', 'APPROVED', 'REJECTED') NOT NULL DEFAULT 'PENDING',
    `reason` TEXT NOT NULL,
    `requested_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `decided_at` DATETIME(3) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    INDEX `approvals_company_id_status_type_idx`(`company_id`, `status`, `type`),
    INDEX `approvals_company_id_branch_id_status_idx`(`company_id`, `branch_id`, `status`),
    INDEX `approvals_ref_type_ref_id_idx`(`ref_type`, `ref_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `approval_rules` (
    `id` CHAR(36) NOT NULL,
    `company_id` CHAR(36) NOT NULL,
    `type` ENUM('PRICE_OVERRIDE', 'REFUND', 'INVENTORY_ADJUSTMENT', 'STOCK_TRANSFER', 'PURCHASE_ORDER', 'WARRANTY_CANCELLATION', 'INVOICE_VOID', 'REOPEN_JOB', 'LARGE_CASH_REFUND', 'MANUAL_JOURNAL') NOT NULL,
    `threshold_amount` BIGINT NULL,
    `threshold_percent` DECIMAL(6, 3) NULL,
    `enabled` BOOLEAN NOT NULL DEFAULT true,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `approval_rules_company_id_type_key`(`company_id`, `type`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `approvals` ADD CONSTRAINT `approvals_company_id_fkey` FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `approvals` ADD CONSTRAINT `approvals_branch_id_fkey` FOREIGN KEY (`branch_id`) REFERENCES `branches`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `approvals` ADD CONSTRAINT `approvals_requested_by_fkey` FOREIGN KEY (`requested_by`) REFERENCES `users`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `approvals` ADD CONSTRAINT `approvals_approved_by_fkey` FOREIGN KEY (`approved_by`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `approval_rules` ADD CONSTRAINT `approval_rules_company_id_fkey` FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
