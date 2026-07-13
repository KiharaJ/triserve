-- CreateTable
CREATE TABLE `warranty_registrations` (
    `id` CHAR(36) NOT NULL,
    `company_id` CHAR(36) NOT NULL,
    `branch_id` CHAR(36) NOT NULL,
    `customer_id` CHAR(36) NULL,
    `device_id` CHAR(36) NULL,
    `invoice_id` CHAR(36) NULL,
    `product_name` VARCHAR(255) NOT NULL,
    `brand` VARCHAR(100) NOT NULL DEFAULT '',
    `serial_no` VARCHAR(100) NULL,
    `kind` ENUM('STORE', 'MANUFACTURER', 'SAMSUNG') NOT NULL,
    `start_date` DATE NOT NULL,
    `expiry_date` DATE NOT NULL,
    `months` INTEGER NULL,
    `terms` TEXT NULL,
    `status` ENUM('ACTIVE', 'EXPIRED', 'VOID') NOT NULL DEFAULT 'ACTIVE',
    `notes` TEXT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    `deleted_at` DATETIME(3) NULL,
    `created_by` CHAR(36) NULL,
    `updated_by` CHAR(36) NULL,

    INDEX `warranty_registrations_company_id_serial_no_idx`(`company_id`, `serial_no`),
    INDEX `warranty_registrations_company_id_status_idx`(`company_id`, `status`),
    INDEX `warranty_registrations_company_id_expiry_date_idx`(`company_id`, `expiry_date`),
    INDEX `warranty_registrations_customer_id_idx`(`customer_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `warranty_registrations` ADD CONSTRAINT `warranty_registrations_company_id_fkey` FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `warranty_registrations` ADD CONSTRAINT `warranty_registrations_branch_id_fkey` FOREIGN KEY (`branch_id`) REFERENCES `branches`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `warranty_registrations` ADD CONSTRAINT `warranty_registrations_customer_id_fkey` FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `warranty_registrations` ADD CONSTRAINT `warranty_registrations_device_id_fkey` FOREIGN KEY (`device_id`) REFERENCES `devices`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `warranty_registrations` ADD CONSTRAINT `warranty_registrations_invoice_id_fkey` FOREIGN KEY (`invoice_id`) REFERENCES `invoices`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `warranty_registrations` ADD CONSTRAINT `warranty_registrations_created_by_fkey` FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `warranty_registrations` ADD CONSTRAINT `warranty_registrations_updated_by_fkey` FOREIGN KEY (`updated_by`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
