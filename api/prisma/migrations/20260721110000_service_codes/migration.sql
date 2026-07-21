-- Samsung GSPN diagnostic code vocabulary (§4.7).
--
-- GSPN will not accept a warranty claim without the full code set: a Condition
-- Code, Symptom Code, Defect Code, Defect Type, Defect Block and Repair Code.
-- These are SIX near-identical lookups, so they share one table discriminated
-- by `kind` rather than six clones of fault_codes.
--
-- Deliberately distinct from `fault_codes` / `repair_actions`, which stay the
-- CUSTOMER-facing complaint vocabulary (what the front desk picks and what
-- prints on the job card). `service_codes` is the SAMSUNG-facing engineering
-- vocabulary that goes on the claim. Different readers, different lifecycles.
--
-- `category` optionally narrows a code to one device grouping (HHP/CE/AC/REF);
-- NULL means it applies to all.

-- CreateTable
CREATE TABLE `service_codes` (
    `id` CHAR(36) NOT NULL,
    `company_id` CHAR(36) NOT NULL,
    `kind` ENUM('CONDITION', 'SYMPTOM', 'DEFECT', 'DEFECT_TYPE', 'DEFECT_BLOCK', 'REPAIR') NOT NULL,
    `code` VARCHAR(30) NOT NULL,
    `label` VARCHAR(255) NOT NULL,
    `category` ENUM('HHP', 'CE', 'AC', 'REF', 'OTHER') NULL,
    `sort_order` INTEGER NOT NULL DEFAULT 0,
    `active` BOOLEAN NOT NULL DEFAULT true,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    `deleted_at` DATETIME(3) NULL,
    `created_by` CHAR(36) NULL,
    `updated_by` CHAR(36) NULL,

    INDEX `service_codes_company_id_kind_active_idx`(`company_id`, `kind`, `active`),
    UNIQUE INDEX `service_codes_company_id_kind_code_key`(`company_id`, `kind`, `code`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `service_codes` ADD CONSTRAINT `service_codes_company_id_fkey` FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `service_codes` ADD CONSTRAINT `service_codes_created_by_fkey` FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE `service_codes` ADD CONSTRAINT `service_codes_updated_by_fkey` FOREIGN KEY (`updated_by`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AlterTable: exactly one code of each kind per job, so these are columns on
-- `jobs` rather than a join table.
ALTER TABLE `jobs`
    ADD COLUMN `condition_code_id` CHAR(36) NULL,
    ADD COLUMN `symptom_code_id` CHAR(36) NULL,
    ADD COLUMN `defect_code_id` CHAR(36) NULL,
    ADD COLUMN `defect_type_id` CHAR(36) NULL,
    ADD COLUMN `defect_block_id` CHAR(36) NULL,
    ADD COLUMN `repair_code_id` CHAR(36) NULL,
    ADD COLUMN `repair_description` TEXT NULL;

-- AddForeignKey
ALTER TABLE `jobs` ADD CONSTRAINT `jobs_condition_code_id_fkey` FOREIGN KEY (`condition_code_id`) REFERENCES `service_codes`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE `jobs` ADD CONSTRAINT `jobs_symptom_code_id_fkey` FOREIGN KEY (`symptom_code_id`) REFERENCES `service_codes`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE `jobs` ADD CONSTRAINT `jobs_defect_code_id_fkey` FOREIGN KEY (`defect_code_id`) REFERENCES `service_codes`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE `jobs` ADD CONSTRAINT `jobs_defect_type_id_fkey` FOREIGN KEY (`defect_type_id`) REFERENCES `service_codes`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE `jobs` ADD CONSTRAINT `jobs_defect_block_id_fkey` FOREIGN KEY (`defect_block_id`) REFERENCES `service_codes`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE `jobs` ADD CONSTRAINT `jobs_repair_code_id_fkey` FOREIGN KEY (`repair_code_id`) REFERENCES `service_codes`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
