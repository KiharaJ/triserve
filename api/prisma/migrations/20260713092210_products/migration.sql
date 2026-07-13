-- CreateTable
CREATE TABLE `products` (
    `id` CHAR(36) NOT NULL,
    `company_id` CHAR(36) NOT NULL,
    `sku` VARCHAR(60) NOT NULL,
    `name` VARCHAR(255) NOT NULL,
    `brand` VARCHAR(100) NOT NULL DEFAULT '',
    `device_type` VARCHAR(50) NULL,
    `category` ENUM('HHP', 'CE', 'AC', 'REF', 'OTHER') NOT NULL DEFAULT 'OTHER',
    `sell_price_tzs` BIGINT NULL,
    `cost_usd` BIGINT NULL,
    `stock_qty` INTEGER NOT NULL DEFAULT 0,
    `default_warranty_months` INTEGER NULL,
    `default_warranty_kind` ENUM('STORE', 'MANUFACTURER', 'SAMSUNG') NULL,
    `is_serialized` BOOLEAN NOT NULL DEFAULT false,
    `active` BOOLEAN NOT NULL DEFAULT true,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    `deleted_at` DATETIME(3) NULL,
    `created_by` CHAR(36) NULL,
    `updated_by` CHAR(36) NULL,

    INDEX `products_company_id_active_idx`(`company_id`, `active`),
    UNIQUE INDEX `products_company_id_sku_key`(`company_id`, `sku`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `products` ADD CONSTRAINT `products_company_id_fkey` FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `products` ADD CONSTRAINT `products_created_by_fkey` FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `products` ADD CONSTRAINT `products_updated_by_fkey` FOREIGN KEY (`updated_by`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
