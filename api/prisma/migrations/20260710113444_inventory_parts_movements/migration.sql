-- CreateTable
CREATE TABLE `parts` (
    `id` CHAR(36) NOT NULL,
    `company_id` CHAR(36) NOT NULL,
    `part_number` VARCHAR(100) NOT NULL,
    `description` VARCHAR(500) NOT NULL,
    `category` ENUM('HHP', 'CE', 'AC', 'REF', 'OTHER') NOT NULL,
    `unit_cost_usd` BIGINT NULL,
    `default_sell_price_tzs` BIGINT NULL,
    `compatible_models` JSON NULL,
    `is_serialized` BOOLEAN NOT NULL DEFAULT false,
    `preferred_supplier_id` CHAR(36) NULL,
    `active` BOOLEAN NOT NULL DEFAULT true,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    `deleted_at` DATETIME(3) NULL,
    `created_by` CHAR(36) NULL,
    `updated_by` CHAR(36) NULL,

    INDEX `parts_company_id_category_idx`(`company_id`, `category`),
    UNIQUE INDEX `parts_company_id_part_number_key`(`company_id`, `part_number`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `inventory` (
    `id` CHAR(36) NOT NULL,
    `company_id` CHAR(36) NOT NULL,
    `branch_id` CHAR(36) NOT NULL,
    `part_id` CHAR(36) NOT NULL,
    `bin_location` VARCHAR(50) NULL,
    `qty_on_hand` INTEGER NOT NULL DEFAULT 0,
    `qty_reserved` INTEGER NOT NULL DEFAULT 0,
    `qty_in_transit_in` INTEGER NOT NULL DEFAULT 0,
    `qty_damaged` INTEGER NOT NULL DEFAULT 0,
    `reorder_level` INTEGER NOT NULL DEFAULT 0,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    `created_by` CHAR(36) NULL,
    `updated_by` CHAR(36) NULL,

    INDEX `inventory_company_id_branch_id_idx`(`company_id`, `branch_id`),
    INDEX `inventory_part_id_idx`(`part_id`),
    UNIQUE INDEX `inventory_branch_id_part_id_key`(`branch_id`, `part_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `stock_movements` (
    `id` CHAR(36) NOT NULL,
    `company_id` CHAR(36) NOT NULL,
    `branch_id` CHAR(36) NOT NULL,
    `part_id` CHAR(36) NOT NULL,
    `movement_type` ENUM('RECEIPT', 'CONSUMPTION', 'TRANSFER_OUT', 'TRANSFER_IN', 'ADJUSTMENT', 'SALE', 'RETURN', 'SUPPLIER_RETURN', 'RESERVE', 'UNRESERVE', 'DAMAGE') NOT NULL,
    `qty` INTEGER NOT NULL,
    `ref_type` ENUM('JOB', 'GRN', 'TRANSFER', 'POS_SALE', 'COUNT', 'ADJUSTMENT') NULL,
    `ref_id` CHAR(36) NULL,
    `unit_cost` BIGINT NULL,
    `cost_currency` CHAR(3) NULL,
    `reason` TEXT NULL,
    `moved_by` CHAR(36) NOT NULL,
    `moved_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `stock_movements_company_id_branch_id_part_id_moved_at_idx`(`company_id`, `branch_id`, `part_id`, `moved_at`),
    INDEX `stock_movements_company_id_movement_type_moved_at_idx`(`company_id`, `movement_type`, `moved_at`),
    INDEX `stock_movements_ref_type_ref_id_idx`(`ref_type`, `ref_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `parts` ADD CONSTRAINT `parts_created_by_fkey` FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `parts` ADD CONSTRAINT `parts_updated_by_fkey` FOREIGN KEY (`updated_by`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `parts` ADD CONSTRAINT `parts_company_id_fkey` FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `inventory` ADD CONSTRAINT `inventory_created_by_fkey` FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `inventory` ADD CONSTRAINT `inventory_updated_by_fkey` FOREIGN KEY (`updated_by`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `inventory` ADD CONSTRAINT `inventory_company_id_fkey` FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `inventory` ADD CONSTRAINT `inventory_branch_id_fkey` FOREIGN KEY (`branch_id`) REFERENCES `branches`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `inventory` ADD CONSTRAINT `inventory_part_id_fkey` FOREIGN KEY (`part_id`) REFERENCES `parts`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `stock_movements` ADD CONSTRAINT `stock_movements_company_id_fkey` FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `stock_movements` ADD CONSTRAINT `stock_movements_branch_id_fkey` FOREIGN KEY (`branch_id`) REFERENCES `branches`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `stock_movements` ADD CONSTRAINT `stock_movements_part_id_fkey` FOREIGN KEY (`part_id`) REFERENCES `parts`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `stock_movements` ADD CONSTRAINT `stock_movements_moved_by_fkey` FOREIGN KEY (`moved_by`) REFERENCES `users`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
