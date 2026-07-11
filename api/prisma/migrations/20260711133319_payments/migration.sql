-- CreateTable
CREATE TABLE `payments` (
    `id` CHAR(36) NOT NULL,
    `company_id` CHAR(36) NOT NULL,
    `invoice_id` CHAR(36) NOT NULL,
    `branch_id` CHAR(36) NOT NULL,
    `method` ENUM('CASH', 'MPESA', 'TIGOPESA', 'AIRTEL', 'CARD', 'BANK') NOT NULL,
    `amount` BIGINT NOT NULL,
    `currency` CHAR(3) NOT NULL,
    `reference` VARCHAR(100) NULL,
    `paid_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `received_by` CHAR(36) NOT NULL,
    `notes` TEXT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `payments_company_id_invoice_id_idx`(`company_id`, `invoice_id`),
    INDEX `payments_company_id_branch_id_paid_at_idx`(`company_id`, `branch_id`, `paid_at`),
    INDEX `payments_company_id_method_paid_at_idx`(`company_id`, `method`, `paid_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `payments` ADD CONSTRAINT `payments_company_id_fkey` FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `payments` ADD CONSTRAINT `payments_invoice_id_fkey` FOREIGN KEY (`invoice_id`) REFERENCES `invoices`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `payments` ADD CONSTRAINT `payments_branch_id_fkey` FOREIGN KEY (`branch_id`) REFERENCES `branches`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `payments` ADD CONSTRAINT `payments_received_by_fkey` FOREIGN KEY (`received_by`) REFERENCES `users`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
