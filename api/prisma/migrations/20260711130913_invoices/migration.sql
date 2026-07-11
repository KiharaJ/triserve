-- CreateTable
CREATE TABLE `invoices` (
    `id` CHAR(36) NOT NULL,
    `company_id` CHAR(36) NOT NULL,
    `invoice_no` VARCHAR(50) NOT NULL,
    `branch_id` CHAR(36) NOT NULL,
    `customer_id` CHAR(36) NULL,
    `job_id` CHAR(36) NULL,
    `type` ENUM('REPAIR_OW', 'PRODUCT_SALE', 'PARTS_SALE', 'ACCESSORY') NOT NULL,
    `currency` CHAR(3) NOT NULL,
    `subtotal` BIGINT NOT NULL DEFAULT 0,
    `discount` BIGINT NOT NULL DEFAULT 0,
    `tax` BIGINT NOT NULL DEFAULT 0,
    `total` BIGINT NOT NULL DEFAULT 0,
    `status` ENUM('DRAFT', 'PARTIAL', 'PAID', 'VOID', 'REFUNDED') NOT NULL DEFAULT 'DRAFT',
    `sold_by` CHAR(36) NOT NULL,
    `notes` TEXT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    `deleted_at` DATETIME(3) NULL,
    `created_by` CHAR(36) NULL,
    `updated_by` CHAR(36) NULL,

    INDEX `invoices_company_id_status_idx`(`company_id`, `status`),
    INDEX `invoices_company_id_branch_id_status_idx`(`company_id`, `branch_id`, `status`),
    INDEX `invoices_customer_id_idx`(`customer_id`),
    INDEX `invoices_job_id_idx`(`job_id`),
    UNIQUE INDEX `invoices_company_id_invoice_no_key`(`company_id`, `invoice_no`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `invoice_lines` (
    `id` CHAR(36) NOT NULL,
    `invoice_id` CHAR(36) NOT NULL,
    `line_type` ENUM('PART', 'PRODUCT', 'SERVICE', 'CUSTOM') NOT NULL,
    `part_id` CHAR(36) NULL,
    `description` VARCHAR(500) NOT NULL,
    `qty` INTEGER NOT NULL,
    `unit_price` BIGINT NOT NULL,
    `line_total` BIGINT NOT NULL,
    `is_warranty` BOOLEAN NOT NULL DEFAULT false,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `invoice_lines_invoice_id_idx`(`invoice_id`),
    INDEX `invoice_lines_part_id_idx`(`part_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `invoice_counters` (
    `id` CHAR(36) NOT NULL,
    `company_id` CHAR(36) NOT NULL,
    `branch_id` CHAR(36) NOT NULL,
    `year` INTEGER NOT NULL,
    `next_seq` INTEGER NOT NULL DEFAULT 0,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `invoice_counters_company_id_branch_id_year_key`(`company_id`, `branch_id`, `year`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `invoices` ADD CONSTRAINT `invoices_company_id_fkey` FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `invoices` ADD CONSTRAINT `invoices_branch_id_fkey` FOREIGN KEY (`branch_id`) REFERENCES `branches`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `invoices` ADD CONSTRAINT `invoices_customer_id_fkey` FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `invoices` ADD CONSTRAINT `invoices_job_id_fkey` FOREIGN KEY (`job_id`) REFERENCES `jobs`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `invoices` ADD CONSTRAINT `invoices_sold_by_fkey` FOREIGN KEY (`sold_by`) REFERENCES `users`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `invoice_lines` ADD CONSTRAINT `invoice_lines_invoice_id_fkey` FOREIGN KEY (`invoice_id`) REFERENCES `invoices`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `invoice_lines` ADD CONSTRAINT `invoice_lines_part_id_fkey` FOREIGN KEY (`part_id`) REFERENCES `parts`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
