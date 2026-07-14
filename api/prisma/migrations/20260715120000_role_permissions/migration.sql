-- CreateTable
CREATE TABLE `role_permissions` (
    `id` CHAR(36) NOT NULL,
    `company_id` CHAR(36) NOT NULL,
    `role` ENUM('SUPER_ADMIN', 'BRANCH_MANAGER', 'SERVICE_ADVISOR', 'TECHNICIAN', 'STOREKEEPER', 'WARRANTY_CLERK', 'ACCOUNTANT') NOT NULL,
    `permission` VARCHAR(100) NOT NULL,
    `granted` BOOLEAN NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    `created_by` CHAR(36) NULL,
    `updated_by` CHAR(36) NULL,

    INDEX `role_permissions_company_id_role_idx`(`company_id`, `role`),
    UNIQUE INDEX `role_permissions_company_id_role_permission_key`(`company_id`, `role`, `permission`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `role_permissions` ADD CONSTRAINT `role_permissions_company_id_fkey` FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
