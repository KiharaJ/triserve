-- Warranty claim detail (§4.7): GSPN's three reference numbers, the cost
-- breakdown, and the itemised part lines.
--
-- GSPN's Warranty Claim Detail settles a claim as Labour + Part + Shipping +
-- Tax (e.g. 16.52 + 12.83 + 10.95 + 0.00 = 40.30). Storing only the total made
-- a short payment un-diagnosable: `reimbursed_amount_usd` could differ from
-- `claim_amount_usd` with no way to see WHICH component Samsung cut.
--
-- `claim_amount_usd` remains the authoritative total. The components are NOT
-- backfilled — pre-existing claims were captured as a single figure and any
-- split would be invented. Treat all-zero components as "legacy, unsplit".

-- AlterTable
ALTER TABLE `warranty_claims`
    ADD COLUMN `samsung_ref_no` VARCHAR(100) NULL,
    ADD COLUMN `ticket_no` VARCHAR(100) NULL,
    ADD COLUMN `gspn_status` VARCHAR(50) NULL,
    ADD COLUMN `labour_amount_usd` BIGINT NOT NULL DEFAULT 0,
    ADD COLUMN `parts_amount_usd` BIGINT NOT NULL DEFAULT 0,
    ADD COLUMN `shipping_amount_usd` BIGINT NOT NULL DEFAULT 0,
    ADD COLUMN `tax_amount_usd` BIGINT NOT NULL DEFAULT 0,
    ADD COLUMN `repair_received_at` DATETIME(3) NULL,
    ADD COLUMN `completed_at` DATETIME(3) NULL,
    ADD COLUMN `delivered_at` DATETIME(3) NULL;

-- CreateIndex
CREATE INDEX `warranty_claims_company_id_samsung_ref_no_idx` ON `warranty_claims`(`company_id`, `samsung_ref_no`);

-- CreateTable: the parts claimed against Samsung. Prices here are Samsung's
-- REIMBURSEMENT prices in USD minor units — deliberately not job_parts, whose
-- unit_sell_price is what a customer would have been charged in TZS.
-- `part_no` is denormalised alongside `part_id` so a claim stays legible after
-- a part is renamed or delisted from the local catalogue.
CREATE TABLE `warranty_claim_lines` (
    `id` CHAR(36) NOT NULL,
    `company_id` CHAR(36) NOT NULL,
    `claim_id` CHAR(36) NOT NULL,
    `line_no` INTEGER NOT NULL,
    `part_id` CHAR(36) NULL,
    `part_no` VARCHAR(100) NOT NULL,
    `description` VARCHAR(500) NULL,
    `location` VARCHAR(100) NULL,
    `qty` INTEGER NOT NULL DEFAULT 1,
    `unit_price_usd` BIGINT NOT NULL,
    `amount_usd` BIGINT NOT NULL,
    `part_serial_no` VARCHAR(100) NULL,
    `invoice_no` VARCHAR(100) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    `deleted_at` DATETIME(3) NULL,
    `created_by` CHAR(36) NULL,
    `updated_by` CHAR(36) NULL,

    INDEX `warranty_claim_lines_company_id_idx`(`company_id`),
    INDEX `warranty_claim_lines_part_id_idx`(`part_id`),
    UNIQUE INDEX `warranty_claim_lines_claim_id_line_no_key`(`claim_id`, `line_no`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `warranty_claim_lines` ADD CONSTRAINT `warranty_claim_lines_company_id_fkey` FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `warranty_claim_lines` ADD CONSTRAINT `warranty_claim_lines_claim_id_fkey` FOREIGN KEY (`claim_id`) REFERENCES `warranty_claims`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `warranty_claim_lines` ADD CONSTRAINT `warranty_claim_lines_part_id_fkey` FOREIGN KEY (`part_id`) REFERENCES `parts`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE `warranty_claim_lines` ADD CONSTRAINT `warranty_claim_lines_created_by_fkey` FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE `warranty_claim_lines` ADD CONSTRAINT `warranty_claim_lines_updated_by_fkey` FOREIGN KEY (`updated_by`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
