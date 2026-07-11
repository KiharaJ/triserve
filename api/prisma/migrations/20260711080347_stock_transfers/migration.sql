-- CreateTable
CREATE TABLE `stock_transfers` (
    `id` CHAR(36) NOT NULL,
    `company_id` CHAR(36) NOT NULL,
    `transfer_no` VARCHAR(50) NOT NULL,
    `from_branch_id` CHAR(36) NOT NULL,
    `to_branch_id` CHAR(36) NOT NULL,
    `status` ENUM('DRAFT', 'DISPATCHED', 'RECEIVED', 'CANCELLED') NOT NULL DEFAULT 'DRAFT',
    `notes` TEXT NULL,
    `dispatched_at` DATETIME(3) NULL,
    `dispatched_by` CHAR(36) NULL,
    `received_at` DATETIME(3) NULL,
    `received_by` CHAR(36) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    `deleted_at` DATETIME(3) NULL,
    `created_by` CHAR(36) NULL,
    `updated_by` CHAR(36) NULL,

    INDEX `stock_transfers_company_id_status_idx`(`company_id`, `status`),
    INDEX `stock_transfers_company_id_from_branch_id_idx`(`company_id`, `from_branch_id`),
    INDEX `stock_transfers_company_id_to_branch_id_idx`(`company_id`, `to_branch_id`),
    UNIQUE INDEX `stock_transfers_company_id_transfer_no_key`(`company_id`, `transfer_no`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `stock_transfer_lines` (
    `id` CHAR(36) NOT NULL,
    `transfer_id` CHAR(36) NOT NULL,
    `part_id` CHAR(36) NOT NULL,
    `qty` INTEGER NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `stock_transfer_lines_transfer_id_idx`(`transfer_id`),
    INDEX `stock_transfer_lines_part_id_idx`(`part_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `transfer_counters` (
    `id` CHAR(36) NOT NULL,
    `company_id` CHAR(36) NOT NULL,
    `year` INTEGER NOT NULL,
    `next_seq` INTEGER NOT NULL DEFAULT 0,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `transfer_counters_company_id_year_key`(`company_id`, `year`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `stock_transfers` ADD CONSTRAINT `stock_transfers_company_id_fkey` FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `stock_transfers` ADD CONSTRAINT `stock_transfers_from_branch_id_fkey` FOREIGN KEY (`from_branch_id`) REFERENCES `branches`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `stock_transfers` ADD CONSTRAINT `stock_transfers_to_branch_id_fkey` FOREIGN KEY (`to_branch_id`) REFERENCES `branches`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `stock_transfers` ADD CONSTRAINT `stock_transfers_dispatched_by_fkey` FOREIGN KEY (`dispatched_by`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `stock_transfers` ADD CONSTRAINT `stock_transfers_received_by_fkey` FOREIGN KEY (`received_by`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `stock_transfers` ADD CONSTRAINT `stock_transfers_created_by_fkey` FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `stock_transfers` ADD CONSTRAINT `stock_transfers_updated_by_fkey` FOREIGN KEY (`updated_by`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `stock_transfer_lines` ADD CONSTRAINT `stock_transfer_lines_transfer_id_fkey` FOREIGN KEY (`transfer_id`) REFERENCES `stock_transfers`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `stock_transfer_lines` ADD CONSTRAINT `stock_transfer_lines_part_id_fkey` FOREIGN KEY (`part_id`) REFERENCES `parts`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
