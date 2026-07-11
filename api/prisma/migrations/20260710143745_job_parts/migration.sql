-- CreateTable
CREATE TABLE `job_parts` (
    `id` CHAR(36) NOT NULL,
    `company_id` CHAR(36) NOT NULL,
    `job_id` CHAR(36) NOT NULL,
    `part_id` CHAR(36) NOT NULL,
    `qty` INTEGER NOT NULL,
    `unit_sell_price` BIGINT NULL,
    `currency` CHAR(3) NULL,
    `is_warranty` BOOLEAN NOT NULL DEFAULT false,
    `status` ENUM('RESERVED', 'CONSUMED') NOT NULL DEFAULT 'RESERVED',
    `reserved_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `consumed_at` DATETIME(3) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    `created_by` CHAR(36) NULL,
    `updated_by` CHAR(36) NULL,

    INDEX `job_parts_company_id_job_id_idx`(`company_id`, `job_id`),
    INDEX `job_parts_part_id_idx`(`part_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `job_parts` ADD CONSTRAINT `job_parts_created_by_fkey` FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `job_parts` ADD CONSTRAINT `job_parts_updated_by_fkey` FOREIGN KEY (`updated_by`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `job_parts` ADD CONSTRAINT `job_parts_company_id_fkey` FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `job_parts` ADD CONSTRAINT `job_parts_job_id_fkey` FOREIGN KEY (`job_id`) REFERENCES `jobs`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `job_parts` ADD CONSTRAINT `job_parts_part_id_fkey` FOREIGN KEY (`part_id`) REFERENCES `parts`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
