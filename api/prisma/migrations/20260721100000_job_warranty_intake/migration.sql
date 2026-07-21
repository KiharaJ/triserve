-- Warranty intake facts on a job (§4.3/§4.7) — the inputs that DECIDE coverage,
-- plus the custody/date fields the Samsung SO job card prints.
--
-- `coverage` is deliberately SEPARATE from `warranty_status`: the latter stays
-- the IW/OW/GOODWILL fact, the former is the BILLING consequence (Samsung's job
-- card offers Full / Labour-only / Parts-only / Out-of-warranty as four distinct
-- boxes, and labour-only vs parts-only decide what the customer is charged).
-- Invoicing must read `coverage`, never `warranty_status`.

-- AlterTable: purchase date is the primary input to the IW/OW decision when no
-- warranty_registration exists (Samsung prints it on the job card).
ALTER TABLE `devices` ADD COLUMN `purchase_date` DATE NULL;

-- AlterTable
ALTER TABLE `jobs`
    ADD COLUMN `service_type` ENUM('CARRY_IN', 'PICKUP', 'IN_HOME', 'INITIAL_INSTALL', 'INSPECTION', 'INSURANCE', 'PRODUCT_RETURN', 'RETURN_HANDLING', 'STOCK_REPAIR', 'ADH') NOT NULL DEFAULT 'CARRY_IN',
    ADD COLUMN `coverage` ENUM('FULL', 'LABOUR_ONLY', 'PARTS_ONLY', 'NONE') NOT NULL DEFAULT 'NONE',
    ADD COLUMN `warranty_source` ENUM('REGISTRATION', 'PURCHASE_DATE', 'MANUAL', 'GOODWILL') NULL,
    ADD COLUMN `warranty_registration_id` CHAR(36) NULL,
    ADD COLUMN `warranty_decided_by` CHAR(36) NULL,
    ADD COLUMN `warranty_decided_at` DATETIME(3) NULL,
    ADD COLUMN `accessories_held` VARCHAR(500) NULL,
    ADD COLUMN `appointment_at` DATETIME(3) NULL,
    ADD COLUMN `return_by_date` DATE NULL,
    ADD COLUMN `repair_warranty_until` DATE NULL;

-- Backfill: IW jobs were fully covered; GOODWILL is a free repair the shop
-- absorbs (customer pays nothing, so coverage is FULL but the source differs).
-- OW/UNKNOWN keep the NONE default.
UPDATE `jobs` SET `coverage` = 'FULL', `warranty_source` = 'MANUAL' WHERE `warranty_status` = 'IW';
UPDATE `jobs` SET `coverage` = 'FULL', `warranty_source` = 'GOODWILL' WHERE `warranty_status` = 'GOODWILL';

-- CreateIndex
CREATE INDEX `jobs_company_id_coverage_idx` ON `jobs`(`company_id`, `coverage`);
CREATE INDEX `jobs_warranty_registration_id_idx` ON `jobs`(`warranty_registration_id`);

-- AddForeignKey
ALTER TABLE `jobs` ADD CONSTRAINT `jobs_warranty_registration_id_fkey` FOREIGN KEY (`warranty_registration_id`) REFERENCES `warranty_registrations`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE `jobs` ADD CONSTRAINT `jobs_warranty_decided_by_fkey` FOREIGN KEY (`warranty_decided_by`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
