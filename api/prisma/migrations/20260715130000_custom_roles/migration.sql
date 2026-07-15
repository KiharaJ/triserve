-- Custom roles (E17b): role registry + convert enum role columns to VARCHAR keys.

-- CreateTable
CREATE TABLE `roles` (
    `id` CHAR(36) NOT NULL,
    `company_id` CHAR(36) NOT NULL,
    `key` VARCHAR(50) NOT NULL,
    `label` VARCHAR(100) NOT NULL,
    `description` VARCHAR(255) NULL,
    `is_system` BOOLEAN NOT NULL DEFAULT false,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    `created_by` CHAR(36) NULL,
    `updated_by` CHAR(36) NULL,

    UNIQUE INDEX `roles_company_id_key_key`(`company_id`, `key`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `roles` ADD CONSTRAINT `roles_company_id_fkey` FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- Backfill: seed the seven built-in roles for every existing company.
INSERT INTO `roles` (`id`, `company_id`, `key`, `label`, `description`, `is_system`, `created_at`, `updated_at`)
SELECT UUID(), c.`id`, r.`k`, r.`label`, r.`descr`, true, NOW(3), NOW(3)
FROM `companies` c
CROSS JOIN (
             SELECT 'SUPER_ADMIN'     AS `k`, 'Super Admin'     AS `label`, 'Full access to every area - cannot be restricted.'            AS `descr`
   UNION ALL SELECT 'BRANCH_MANAGER',       'Branch Manager',        'Runs a branch: approvals, staff, stock and reporting.'
   UNION ALL SELECT 'SERVICE_ADVISOR',      'Service Advisor',       'Front desk: customers, intake, invoicing and handover.'
   UNION ALL SELECT 'TECHNICIAN',           'Technician',            'Bench: works on and moves assigned repair jobs.'
   UNION ALL SELECT 'STOREKEEPER',          'Storekeeper',           'Parts and stock: catalogue, counts, transfers and receiving.'
   UNION ALL SELECT 'WARRANTY_CLERK',       'Warranty Clerk',        'Handles warranty claims end to end.'
   UNION ALL SELECT 'ACCOUNTANT',           'Accountant',            'Group-wide finance: ledger, posting and reports.'
) r;

-- AlterTable: role columns become VARCHAR role keys (existing enum values preserved).
ALTER TABLE `users` MODIFY `role` VARCHAR(50) NOT NULL;
ALTER TABLE `role_permissions` MODIFY `role` VARCHAR(50) NOT NULL;
