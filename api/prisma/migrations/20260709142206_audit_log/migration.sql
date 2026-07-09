-- CreateTable
CREATE TABLE `audit_log` (
    `id` CHAR(36) NOT NULL,
    `company_id` CHAR(36) NOT NULL,
    `branch_id` CHAR(36) NULL,
    `actor_user_id` CHAR(36) NULL,
    `entity_type` VARCHAR(100) NOT NULL,
    `entity_id` CHAR(36) NOT NULL,
    `action` ENUM('CREATE', 'UPDATE', 'DELETE', 'TRANSITION', 'LOGIN', 'APPROVE', 'REJECT') NOT NULL,
    `before_json` JSON NULL,
    `after_json` JSON NULL,
    `at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `ip` VARCHAR(64) NULL,
    `user_agent` VARCHAR(500) NULL,

    INDEX `audit_log_company_id_entity_type_entity_id_idx`(`company_id`, `entity_type`, `entity_id`),
    INDEX `audit_log_company_id_at_idx`(`company_id`, `at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
