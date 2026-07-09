-- CreateTable
CREATE TABLE `jobs` (
    `id` CHAR(36) NOT NULL,
    `company_id` CHAR(36) NOT NULL,
    `job_no` VARCHAR(50) NOT NULL,
    `so_number` VARCHAR(100) NULL,
    `branch_id` CHAR(36) NOT NULL,
    `customer_id` CHAR(36) NOT NULL,
    `device_id` CHAR(36) NOT NULL,
    `booked_by` CHAR(36) NOT NULL,
    `assigned_engineer_id` CHAR(36) NULL,
    `warranty_status` ENUM('IW', 'OW', 'GOODWILL', 'UNKNOWN') NOT NULL DEFAULT 'UNKNOWN',
    `fault_reported` TEXT NULL,
    `fault_code_id` CHAR(36) NULL,
    `tech_report` TEXT NULL,
    `state_id` CHAR(36) NOT NULL,
    `received_at` DATETIME(3) NOT NULL,
    `ready_at` DATETIME(3) NULL,
    `dispatched_at` DATETIME(3) NULL,
    `dispatched_by` CHAR(36) NULL,
    `received_by_customer` VARCHAR(255) NULL,
    `waybill_no` VARCHAR(100) NULL,
    `claim_id` CHAR(36) NULL,
    `invoice_id` CHAR(36) NULL,
    `notes` TEXT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    `deleted_at` DATETIME(3) NULL,
    `created_by` CHAR(36) NULL,
    `updated_by` CHAR(36) NULL,

    INDEX `jobs_company_id_branch_id_state_id_idx`(`company_id`, `branch_id`, `state_id`),
    INDEX `jobs_company_id_assigned_engineer_id_idx`(`company_id`, `assigned_engineer_id`),
    INDEX `jobs_company_id_received_at_idx`(`company_id`, `received_at`),
    INDEX `jobs_customer_id_idx`(`customer_id`),
    INDEX `jobs_device_id_idx`(`device_id`),
    UNIQUE INDEX `jobs_company_id_job_no_key`(`company_id`, `job_no`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `job_counters` (
    `id` CHAR(36) NOT NULL,
    `company_id` CHAR(36) NOT NULL,
    `branch_id` CHAR(36) NOT NULL,
    `year` INTEGER NOT NULL,
    `next_seq` INTEGER NOT NULL DEFAULT 0,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `job_counters_company_id_branch_id_year_key`(`company_id`, `branch_id`, `year`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `jobs` ADD CONSTRAINT `jobs_company_id_fkey` FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `jobs` ADD CONSTRAINT `jobs_branch_id_fkey` FOREIGN KEY (`branch_id`) REFERENCES `branches`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `jobs` ADD CONSTRAINT `jobs_customer_id_fkey` FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `jobs` ADD CONSTRAINT `jobs_device_id_fkey` FOREIGN KEY (`device_id`) REFERENCES `devices`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `jobs` ADD CONSTRAINT `jobs_booked_by_fkey` FOREIGN KEY (`booked_by`) REFERENCES `users`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `jobs` ADD CONSTRAINT `jobs_assigned_engineer_id_fkey` FOREIGN KEY (`assigned_engineer_id`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `jobs` ADD CONSTRAINT `jobs_fault_code_id_fkey` FOREIGN KEY (`fault_code_id`) REFERENCES `fault_codes`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `jobs` ADD CONSTRAINT `jobs_state_id_fkey` FOREIGN KEY (`state_id`) REFERENCES `workflow_states`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `jobs` ADD CONSTRAINT `jobs_dispatched_by_fkey` FOREIGN KEY (`dispatched_by`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `jobs` ADD CONSTRAINT `jobs_created_by_fkey` FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `jobs` ADD CONSTRAINT `jobs_updated_by_fkey` FOREIGN KEY (`updated_by`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
