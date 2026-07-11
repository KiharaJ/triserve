-- CreateTable
CREATE TABLE `goods_received_notes` (
    `id` CHAR(36) NOT NULL,
    `company_id` CHAR(36) NOT NULL,
    `grn_no` VARCHAR(50) NOT NULL,
    `po_id` CHAR(36) NOT NULL,
    `branch_id` CHAR(36) NOT NULL,
    `received_date` DATE NOT NULL,
    `received_by` CHAR(36) NOT NULL,
    `supplier_delivery_ref` VARCHAR(100) NULL,
    `notes` TEXT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `goods_received_notes_company_id_branch_id_idx`(`company_id`, `branch_id`),
    INDEX `goods_received_notes_po_id_idx`(`po_id`),
    UNIQUE INDEX `goods_received_notes_company_id_grn_no_key`(`company_id`, `grn_no`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `grn_lines` (
    `id` CHAR(36) NOT NULL,
    `grn_id` CHAR(36) NOT NULL,
    `po_line_id` CHAR(36) NOT NULL,
    `part_id` CHAR(36) NOT NULL,
    `qty_received` INTEGER NOT NULL,
    `qty_rejected` INTEGER NOT NULL DEFAULT 0,
    `unit_cost` BIGINT NOT NULL,
    `bin_location` VARCHAR(50) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `grn_lines_grn_id_idx`(`grn_id`),
    INDEX `grn_lines_po_line_id_idx`(`po_line_id`),
    INDEX `grn_lines_part_id_idx`(`part_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `grn_counters` (
    `id` CHAR(36) NOT NULL,
    `company_id` CHAR(36) NOT NULL,
    `branch_id` CHAR(36) NOT NULL,
    `year` INTEGER NOT NULL,
    `next_seq` INTEGER NOT NULL DEFAULT 0,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `grn_counters_company_id_branch_id_year_key`(`company_id`, `branch_id`, `year`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `goods_received_notes` ADD CONSTRAINT `goods_received_notes_company_id_fkey` FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `goods_received_notes` ADD CONSTRAINT `goods_received_notes_po_id_fkey` FOREIGN KEY (`po_id`) REFERENCES `purchase_orders`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `goods_received_notes` ADD CONSTRAINT `goods_received_notes_branch_id_fkey` FOREIGN KEY (`branch_id`) REFERENCES `branches`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `goods_received_notes` ADD CONSTRAINT `goods_received_notes_received_by_fkey` FOREIGN KEY (`received_by`) REFERENCES `users`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `grn_lines` ADD CONSTRAINT `grn_lines_grn_id_fkey` FOREIGN KEY (`grn_id`) REFERENCES `goods_received_notes`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `grn_lines` ADD CONSTRAINT `grn_lines_po_line_id_fkey` FOREIGN KEY (`po_line_id`) REFERENCES `purchase_order_lines`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `grn_lines` ADD CONSTRAINT `grn_lines_part_id_fkey` FOREIGN KEY (`part_id`) REFERENCES `parts`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
