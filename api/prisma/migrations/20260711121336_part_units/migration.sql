-- CreateTable
CREATE TABLE `part_units` (
    `id` CHAR(36) NOT NULL,
    `company_id` CHAR(36) NOT NULL,
    `part_id` CHAR(36) NOT NULL,
    `serial_no` VARCHAR(100) NOT NULL,
    `branch_id` CHAR(36) NOT NULL,
    `status` ENUM('IN_STOCK', 'RESERVED', 'INSTALLED', 'RETURNED', 'DAMAGED') NOT NULL DEFAULT 'IN_STOCK',
    `supplier_id` CHAR(36) NULL,
    `grn_id` CHAR(36) NULL,
    `installed_on_job_id` CHAR(36) NULL,
    `removed_from_job_id` CHAR(36) NULL,
    `warranty_expiry` DATE NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    `deleted_at` DATETIME(3) NULL,
    `created_by` CHAR(36) NULL,
    `updated_by` CHAR(36) NULL,

    INDEX `part_units_company_id_serial_no_idx`(`company_id`, `serial_no`),
    INDEX `part_units_company_id_branch_id_status_idx`(`company_id`, `branch_id`, `status`),
    INDEX `part_units_part_id_status_idx`(`part_id`, `status`),
    UNIQUE INDEX `part_units_company_id_part_id_serial_no_key`(`company_id`, `part_id`, `serial_no`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `part_units` ADD CONSTRAINT `part_units_created_by_fkey` FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `part_units` ADD CONSTRAINT `part_units_updated_by_fkey` FOREIGN KEY (`updated_by`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `part_units` ADD CONSTRAINT `part_units_company_id_fkey` FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `part_units` ADD CONSTRAINT `part_units_part_id_fkey` FOREIGN KEY (`part_id`) REFERENCES `parts`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `part_units` ADD CONSTRAINT `part_units_branch_id_fkey` FOREIGN KEY (`branch_id`) REFERENCES `branches`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
