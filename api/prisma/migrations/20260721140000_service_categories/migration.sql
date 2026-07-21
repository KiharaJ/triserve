-- What service the customer is asking for, and how urgently (§4.3).
--
-- Neither existed. The three adjacent fields all answer something else:
--   devices.category (HHP/CE/AC/REF)  Samsung's REPAIR GROUPING, on the
--                                     device — it drives parts compatibility;
--   devices.device_type               a free display label for the register;
--   jobs.service_type (CARRY_IN…)     HOW the device arrives, not what is
--                                     wanted.
-- So "mobile repair vs TV repair vs AC repair" was only ever inferred from
-- the device, and triage had no signal at all.

-- CreateTable: service lines are DATA, not an enum — a company adds its own
-- (installation, diagnostics-only, insurance work…) without a migration, the
-- same way fault codes and workflow states already work.
CREATE TABLE `service_categories` (
    `id` CHAR(36) NOT NULL,
    `company_id` CHAR(36) NOT NULL,
    `code` VARCHAR(30) NOT NULL,
    `label` VARCHAR(255) NOT NULL,
    -- Turnaround this line is normally promised in. NULL = no standard.
    `default_sla_hours` INTEGER NULL,
    `sort_order` INTEGER NOT NULL DEFAULT 0,
    `active` BOOLEAN NOT NULL DEFAULT true,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    `deleted_at` DATETIME(3) NULL,
    `created_by` CHAR(36) NULL,
    `updated_by` CHAR(36) NULL,

    INDEX `service_categories_company_id_active_idx`(`company_id`, `active`),
    UNIQUE INDEX `service_categories_company_id_code_key`(`company_id`, `code`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `service_categories` ADD CONSTRAINT `service_categories_company_id_fkey` FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `service_categories` ADD CONSTRAINT `service_categories_created_by_fkey` FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE `service_categories` ADD CONSTRAINT `service_categories_updated_by_fkey` FOREIGN KEY (`updated_by`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AlterTable
--
-- `priority` is an ENUM, unlike the category: sorting and escalation depend on
-- its ORDER, so the set has to be closed. It does NOT compute a date —
-- inventing "urgent = half the time" would be policy we made up. Turnaround
-- comes from the category's SLA; priority is what a human triages by.
--
-- `sla_due_at` is the INTERNAL target (received_at + the category's SLA).
-- Deliberately separate from `return_by_date`, which is the date PROMISED TO
-- THE CUSTOMER — the two differ all the time, and conflating them would make
-- "are we late?" and "did we let the customer down?" the same question.
ALTER TABLE `jobs`
    ADD COLUMN `service_category_id` CHAR(36) NULL,
    ADD COLUMN `priority` ENUM('LOW', 'NORMAL', 'HIGH', 'URGENT') NOT NULL DEFAULT 'NORMAL',
    ADD COLUMN `sla_due_at` DATETIME(3) NULL;

-- AddForeignKey
ALTER TABLE `jobs` ADD CONSTRAINT `jobs_service_category_id_fkey` FOREIGN KEY (`service_category_id`) REFERENCES `service_categories`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- CreateIndex: the two triage questions — "what is urgent?" and "what is
-- overdue?" — plus the per-line breakdown a manager asks for.
CREATE INDEX `jobs_company_id_priority_idx` ON `jobs`(`company_id`, `priority`);
CREATE INDEX `jobs_company_id_sla_due_at_idx` ON `jobs`(`company_id`, `sla_due_at`);
CREATE INDEX `jobs_service_category_id_idx` ON `jobs`(`service_category_id`);
