-- CreateTable
CREATE TABLE `attachments` (
    `id` CHAR(36) NOT NULL,
    `company_id` CHAR(36) NOT NULL,
    `branch_id` CHAR(36) NULL,
    `owner_type` ENUM('JOB', 'CUSTOMER', 'DEVICE', 'GRN', 'INVOICE') NOT NULL,
    `owner_id` CHAR(36) NOT NULL,
    `kind` ENUM('SIGNATURE', 'PHOTO_BEFORE', 'PHOTO_AFTER', 'VIDEO', 'WARRANTY_CARD', 'PURCHASE_RECEIPT', 'DOC') NOT NULL,
    `file_url` VARCHAR(1024) NOT NULL,
    `file_name` VARCHAR(255) NOT NULL,
    `mime_type` VARCHAR(100) NOT NULL,
    `size_bytes` INTEGER NOT NULL,
    `uploaded_by` CHAR(36) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `attachments_company_id_owner_type_owner_id_idx`(`company_id`, `owner_type`, `owner_id`),
    INDEX `attachments_company_id_branch_id_idx`(`company_id`, `branch_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `attachments` ADD CONSTRAINT `attachments_company_id_fkey` FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `attachments` ADD CONSTRAINT `attachments_branch_id_fkey` FOREIGN KEY (`branch_id`) REFERENCES `branches`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `attachments` ADD CONSTRAINT `attachments_uploaded_by_fkey` FOREIGN KEY (`uploaded_by`) REFERENCES `users`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
