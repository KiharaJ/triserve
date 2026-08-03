-- AlterTable
ALTER TABLE `approval_rules` MODIFY `type` ENUM('PRICE_OVERRIDE', 'REFUND', 'INVENTORY_ADJUSTMENT', 'STOCK_TRANSFER', 'PURCHASE_ORDER', 'WARRANTY_CANCELLATION', 'INVOICE_VOID', 'REOPEN_JOB', 'LARGE_CASH_REFUND', 'MANUAL_JOURNAL', 'CLAIM_SPLIT_MISMATCH', 'OW_REPAIR_WITHOUT_QUOTE', 'DUPLICATE_WARRANTY_CLAIM', 'JOB_COVERAGE_CHANGE', 'BER_CERTIFICATION', 'DEVICE_SWAP', 'WRITE_OFF') NOT NULL;

-- AlterTable
ALTER TABLE `approvals` MODIFY `type` ENUM('PRICE_OVERRIDE', 'REFUND', 'INVENTORY_ADJUSTMENT', 'STOCK_TRANSFER', 'PURCHASE_ORDER', 'WARRANTY_CANCELLATION', 'INVOICE_VOID', 'REOPEN_JOB', 'LARGE_CASH_REFUND', 'MANUAL_JOURNAL', 'CLAIM_SPLIT_MISMATCH', 'OW_REPAIR_WITHOUT_QUOTE', 'DUPLICATE_WARRANTY_CLAIM', 'JOB_COVERAGE_CHANGE', 'BER_CERTIFICATION', 'DEVICE_SWAP', 'WRITE_OFF') NOT NULL;

-- AlterTable
ALTER TABLE `companies` ADD COLUMN `ber_threshold_percent` INTEGER NOT NULL DEFAULT 70,
    ADD COLUMN `otp_max_attempts` INTEGER NOT NULL DEFAULT 5,
    ADD COLUMN `otp_ttl_minutes` INTEGER NOT NULL DEFAULT 1440;

-- AlterTable
ALTER TABLE `devices` ADD COLUMN `decommissioned_at` DATETIME(3) NULL,
    ADD COLUMN `market_value` BIGINT NULL,
    ADD COLUMN `market_value_currency` CHAR(3) NULL,
    ADD COLUMN `replaced_by_device_id` CHAR(36) NULL,
    ADD COLUMN `replaced_device_id` CHAR(36) NULL;

-- AlterTable
ALTER TABLE `inventory` ADD COLUMN `core_bin_location` VARCHAR(50) NULL,
    ADD COLUMN `qty_core_returned` INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE `invoices` ADD COLUMN `approval_expires_at` DATETIME(3) NULL,
    ADD COLUMN `approval_note` VARCHAR(500) NULL,
    ADD COLUMN `approval_recorded_by` CHAR(36) NULL,
    ADD COLUMN `approval_signature_attachment_id` CHAR(36) NULL,
    ADD COLUMN `approval_token_hash` VARCHAR(64) NULL,
    ADD COLUMN `approval_via` VARCHAR(20) NULL,
    ADD COLUMN `customer_approved_at` DATETIME(3) NULL,
    ADD COLUMN `customer_declined_at` DATETIME(3) NULL,
    ADD COLUMN `quote_sent_at` DATETIME(3) NULL,
    ADD COLUMN `quote_sent_to` VARCHAR(255) NULL;

-- AlterTable
ALTER TABLE `job_parts` ADD COLUMN `core_bin_location` VARCHAR(50) NULL,
    ADD COLUMN `core_required` BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN `core_returned_at` DATETIME(3) NULL,
    ADD COLUMN `core_returned_by` CHAR(36) NULL,
    ADD COLUMN `core_serial_no` VARCHAR(100) NULL,
    ADD COLUMN `issued_at` DATETIME(3) NULL,
    ADD COLUMN `issued_by` CHAR(36) NULL,
    ADD COLUMN `new_serial_no` VARCHAR(100) NULL,
    ADD COLUMN `part_unit_id` CHAR(36) NULL,
    ADD COLUMN `pick_bin_location` VARCHAR(50) NULL,
    MODIFY `status` ENUM('RESERVED', 'ISSUED', 'CONSUMED', 'CANCELLED') NOT NULL DEFAULT 'RESERVED';

-- AlterTable
ALTER TABLE `jobs` ADD COLUMN `condition_captured_at` DATETIME(3) NULL,
    ADD COLUMN `condition_captured_by` CHAR(36) NULL,
    ADD COLUMN `diagnosis_started_at` DATETIME(3) NULL,
    ADD COLUMN `estimate_amount` BIGINT NULL,
    ADD COLUMN `estimate_currency` CHAR(3) NULL,
    ADD COLUMN `labour_hours` DECIMAL(6, 2) NULL,
    ADD COLUMN `liquid_indicator_tripped` BOOLEAN NULL,
    ADD COLUMN `qc_approved_at` DATETIME(3) NULL,
    ADD COLUMN `qc_approved_by` CHAR(36) NULL,
    ADD COLUMN `qc_failure_reason` TEXT NULL,
    ADD COLUMN `qc_reject_count` INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN `qc_submitted_at` DATETIME(3) NULL,
    ADD COLUMN `repair_started_at` DATETIME(3) NULL,
    ADD COLUMN `symptom_node_id` CHAR(36) NULL,
    ADD COLUMN `tech_lock_reason` VARCHAR(255) NULL,
    ADD COLUMN `tech_locked` BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN `terms_accepted_at` DATETIME(3) NULL;

-- AlterTable
ALTER TABLE `models` ADD COLUMN `market_value` BIGINT NULL,
    ADD COLUMN `market_value_currency` CHAR(3) NULL;

-- AlterTable
ALTER TABLE `part_units` MODIFY `status` ENUM('IN_STOCK', 'RESERVED', 'INSTALLED', 'RETURNED', 'DAMAGED', 'CORE_RETURNED', 'CORE_DISPATCHED') NOT NULL DEFAULT 'IN_STOCK';

-- AlterTable
ALTER TABLE `parts` ADD COLUMN `requires_core_return` BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE `stock_movements` MODIFY `movement_type` ENUM('RECEIPT', 'CONSUMPTION', 'TRANSFER_OUT', 'TRANSFER_IN', 'ADJUSTMENT', 'SALE', 'RETURN', 'SUPPLIER_RETURN', 'RESERVE', 'UNRESERVE', 'DAMAGE', 'CORE_RETURN', 'CORE_DISPATCH') NOT NULL;

-- AlterTable
ALTER TABLE `workflow_states` ADD COLUMN `hold_kind` ENUM('NONE', 'PARTS', 'CUSTOMER', 'EXTERNAL') NOT NULL DEFAULT 'NONE',
    ADD COLUMN `pauses_sla` BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN `stage` ENUM('INTAKE', 'DIAGNOSIS', 'HOLD', 'REPAIR', 'QC', 'READY', 'DONE') NOT NULL DEFAULT 'INTAKE';

-- CreateTable
CREATE TABLE `symptom_nodes` (
    `id` CHAR(36) NOT NULL,
    `company_id` CHAR(36) NOT NULL,
    `parent_id` CHAR(36) NULL,
    `code` VARCHAR(120) NOT NULL,
    `label` VARCHAR(255) NOT NULL,
    `level` INTEGER NOT NULL DEFAULT 1,
    `is_leaf` BOOLEAN NOT NULL DEFAULT false,
    `category` ENUM('HHP', 'CE', 'AC', 'REF', 'OTHER') NULL,
    `fault_code_id` CHAR(36) NULL,
    `service_category_id` CHAR(36) NULL,
    `estimate_amount` BIGINT NULL,
    `estimate_currency` CHAR(3) NULL,
    `estimate_minutes` INTEGER NULL,
    `sort_order` INTEGER NOT NULL DEFAULT 0,
    `active` BOOLEAN NOT NULL DEFAULT true,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    `deleted_at` DATETIME(3) NULL,
    `created_by` CHAR(36) NULL,
    `updated_by` CHAR(36) NULL,

    INDEX `symptom_nodes_company_id_parent_id_sort_order_idx`(`company_id`, `parent_id`, `sort_order`),
    INDEX `symptom_nodes_company_id_level_active_idx`(`company_id`, `level`, `active`),
    UNIQUE INDEX `symptom_nodes_company_id_code_key`(`company_id`, `code`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `condition_zones` (
    `id` CHAR(36) NOT NULL,
    `company_id` CHAR(36) NOT NULL,
    `category` ENUM('HHP', 'CE', 'AC', 'REF', 'OTHER') NOT NULL,
    `code` VARCHAR(60) NOT NULL,
    `label` VARCHAR(120) NOT NULL,
    `x` DECIMAL(5, 4) NOT NULL,
    `y` DECIMAL(5, 4) NOT NULL,
    `face` VARCHAR(20) NOT NULL DEFAULT 'FRONT',
    `sort_order` INTEGER NOT NULL DEFAULT 0,
    `active` BOOLEAN NOT NULL DEFAULT true,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    `deleted_at` DATETIME(3) NULL,
    `created_by` CHAR(36) NULL,
    `updated_by` CHAR(36) NULL,

    INDEX `condition_zones_company_id_category_active_idx`(`company_id`, `category`, `active`),
    UNIQUE INDEX `condition_zones_company_id_category_code_key`(`company_id`, `category`, `code`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `job_condition_marks` (
    `id` CHAR(36) NOT NULL,
    `company_id` CHAR(36) NOT NULL,
    `job_id` CHAR(36) NOT NULL,
    `zone_id` CHAR(36) NOT NULL,
    `damage` ENUM('SCRATCH', 'HAIRLINE_CRACK', 'CRACK', 'SHATTERED', 'DENT', 'SCUFF', 'CHIP', 'DISCOLOURATION', 'CORROSION', 'BURN', 'MISSING_PART', 'LOOSE_PART', 'WATER_INGRESS', 'LIQUID_INDICATOR_TRIPPED', 'PREVIOUS_REPAIR', 'OTHER') NOT NULL,
    `severity` ENUM('MINOR', 'MODERATE', 'SEVERE') NOT NULL DEFAULT 'MINOR',
    `note` VARCHAR(500) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    `created_by` CHAR(36) NULL,
    `updated_by` CHAR(36) NULL,

    INDEX `job_condition_marks_company_id_job_id_idx`(`company_id`, `job_id`),
    UNIQUE INDEX `job_condition_marks_job_id_zone_id_damage_key`(`job_id`, `zone_id`, `damage`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `user_skills` (
    `id` CHAR(36) NOT NULL,
    `company_id` CHAR(36) NOT NULL,
    `user_id` CHAR(36) NOT NULL,
    `category` ENUM('HHP', 'CE', 'AC', 'REF', 'OTHER') NOT NULL,
    `service_category_id` CHAR(36) NULL,
    `level` INTEGER NOT NULL DEFAULT 1,
    `can_qc` BOOLEAN NOT NULL DEFAULT false,
    `certified_at` DATE NULL,
    `notes` VARCHAR(255) NULL,
    `active` BOOLEAN NOT NULL DEFAULT true,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    `deleted_at` DATETIME(3) NULL,
    `created_by` CHAR(36) NULL,
    `updated_by` CHAR(36) NULL,

    INDEX `user_skills_company_id_category_active_idx`(`company_id`, `category`, `active`),
    UNIQUE INDEX `user_skills_user_id_category_service_category_id_key`(`user_id`, `category`, `service_category_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `job_state_events` (
    `id` CHAR(36) NOT NULL,
    `company_id` CHAR(36) NOT NULL,
    `branch_id` CHAR(36) NOT NULL,
    `job_id` CHAR(36) NOT NULL,
    `state_id` CHAR(36) NOT NULL,
    `from_state_id` CHAR(36) NULL,
    `stage` ENUM('INTAKE', 'DIAGNOSIS', 'HOLD', 'REPAIR', 'QC', 'READY', 'DONE') NOT NULL,
    `hold_kind` ENUM('NONE', 'PARTS', 'CUSTOMER', 'EXTERNAL') NOT NULL DEFAULT 'NONE',
    `pauses_sla` BOOLEAN NOT NULL DEFAULT false,
    `entered_at` DATETIME(3) NOT NULL,
    `exited_at` DATETIME(3) NULL,
    `duration_ms` BIGINT NULL,
    `actor_user_id` CHAR(36) NULL,
    `engineer_id` CHAR(36) NULL,
    `note` VARCHAR(500) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `job_state_events_company_id_job_id_entered_at_idx`(`company_id`, `job_id`, `entered_at`),
    INDEX `job_state_events_company_id_stage_entered_at_idx`(`company_id`, `stage`, `entered_at`),
    INDEX `job_state_events_job_id_exited_at_idx`(`job_id`, `exited_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `qc_checklist_items` (
    `id` CHAR(36) NOT NULL,
    `company_id` CHAR(36) NOT NULL,
    `category` ENUM('HHP', 'CE', 'AC', 'REF', 'OTHER') NOT NULL,
    `code` VARCHAR(60) NOT NULL,
    `label` VARCHAR(255) NOT NULL,
    `help` VARCHAR(500) NULL,
    `requires_value` BOOLEAN NOT NULL DEFAULT false,
    `requires_attachment` BOOLEAN NOT NULL DEFAULT false,
    `blocking` BOOLEAN NOT NULL DEFAULT true,
    `sort_order` INTEGER NOT NULL DEFAULT 0,
    `active` BOOLEAN NOT NULL DEFAULT true,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    `deleted_at` DATETIME(3) NULL,
    `created_by` CHAR(36) NULL,
    `updated_by` CHAR(36) NULL,

    INDEX `qc_checklist_items_company_id_category_active_idx`(`company_id`, `category`, `active`),
    UNIQUE INDEX `qc_checklist_items_company_id_category_code_key`(`company_id`, `category`, `code`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `job_qc_checks` (
    `id` CHAR(36) NOT NULL,
    `company_id` CHAR(36) NOT NULL,
    `job_id` CHAR(36) NOT NULL,
    `item_id` CHAR(36) NOT NULL,
    `attempt_no` INTEGER NOT NULL DEFAULT 1,
    `result` ENUM('PASS', 'FAIL', 'NA') NOT NULL,
    `value` VARCHAR(120) NULL,
    `note` VARCHAR(500) NULL,
    `recorded_by` CHAR(36) NOT NULL,
    `recorded_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    INDEX `job_qc_checks_company_id_job_id_attempt_no_idx`(`company_id`, `job_id`, `attempt_no`),
    UNIQUE INDEX `job_qc_checks_job_id_item_id_attempt_no_key`(`job_id`, `item_id`, `attempt_no`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ber_assessments` (
    `id` CHAR(36) NOT NULL,
    `company_id` CHAR(36) NOT NULL,
    `branch_id` CHAR(36) NOT NULL,
    `job_id` CHAR(36) NOT NULL,
    `certificate_no` VARCHAR(50) NULL,
    `parts_cost` BIGINT NOT NULL,
    `labour_cost` BIGINT NOT NULL,
    `total_cost` BIGINT NOT NULL,
    `device_value` BIGINT NOT NULL,
    `currency` CHAR(3) NOT NULL,
    `ratio_percent` DECIMAL(9, 2) NOT NULL,
    `threshold_percent` INTEGER NOT NULL,
    `valuation_source` VARCHAR(20) NOT NULL,
    `status` ENUM('FLAGGED', 'CERTIFIED', 'REJECTED', 'WITHDRAWN') NOT NULL DEFAULT 'FLAGGED',
    `flagged_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `reviewed_by` CHAR(36) NULL,
    `reviewed_at` DATETIME(3) NULL,
    `decision_notes` TEXT NULL,
    `outcome` ENUM('REPLACE_IW', 'REPLACE_TRADE_UP', 'SALVAGE', 'DECLINED', 'REPAIR_ANYWAY') NULL,
    `customer_responded_at` DATETIME(3) NULL,
    `offer_amount` BIGINT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    `created_by` CHAR(36) NULL,
    `updated_by` CHAR(36) NULL,

    INDEX `ber_assessments_company_id_job_id_flagged_at_idx`(`company_id`, `job_id`, `flagged_at`),
    INDEX `ber_assessments_company_id_branch_id_status_idx`(`company_id`, `branch_id`, `status`),
    UNIQUE INDEX `ber_assessments_company_id_certificate_no_key`(`company_id`, `certificate_no`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ber_certificate_counters` (
    `id` CHAR(36) NOT NULL,
    `company_id` CHAR(36) NOT NULL,
    `branch_id` CHAR(36) NOT NULL,
    `year` INTEGER NOT NULL,
    `next_seq` INTEGER NOT NULL DEFAULT 0,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `ber_certificate_counters_company_id_branch_id_year_key`(`company_id`, `branch_id`, `year`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `swap_units` (
    `id` CHAR(36) NOT NULL,
    `company_id` CHAR(36) NOT NULL,
    `branch_id` CHAR(36) NOT NULL,
    `model_id` CHAR(36) NULL,
    `model_label` VARCHAR(150) NULL,
    `category` ENUM('HHP', 'CE', 'AC', 'REF', 'OTHER') NOT NULL DEFAULT 'HHP',
    `imei_serial` VARCHAR(100) NOT NULL,
    `color` VARCHAR(50) NULL,
    `cost` BIGINT NULL,
    `currency` CHAR(3) NULL,
    `status` ENUM('IN_STOCK', 'ALLOCATED', 'ISSUED', 'RETIRED') NOT NULL DEFAULT 'IN_STOCK',
    `allocated_job_id` CHAR(36) NULL,
    `allocated_at` DATETIME(3) NULL,
    `issued_at` DATETIME(3) NULL,
    `issued_by` CHAR(36) NULL,
    `grn_id` CHAR(36) NULL,
    `notes` VARCHAR(500) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    `deleted_at` DATETIME(3) NULL,
    `created_by` CHAR(36) NULL,
    `updated_by` CHAR(36) NULL,

    INDEX `swap_units_company_id_branch_id_status_idx`(`company_id`, `branch_id`, `status`),
    INDEX `swap_units_allocated_job_id_idx`(`allocated_job_id`),
    UNIQUE INDEX `swap_units_company_id_imei_serial_key`(`company_id`, `imei_serial`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `device_swaps` (
    `id` CHAR(36) NOT NULL,
    `company_id` CHAR(36) NOT NULL,
    `branch_id` CHAR(36) NOT NULL,
    `job_id` CHAR(36) NOT NULL,
    `old_device_id` CHAR(36) NOT NULL,
    `new_device_id` CHAR(36) NOT NULL,
    `swap_unit_id` CHAR(36) NOT NULL,
    `ber_assessment_id` CHAR(36) NULL,
    `old_imei_serial` VARCHAR(100) NULL,
    `new_imei_serial` VARCHAR(100) NULL,
    `history_job_count` INTEGER NOT NULL DEFAULT 0,
    `reason` VARCHAR(500) NULL,
    `authorized_by` CHAR(36) NOT NULL,
    `authorized_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    `created_by` CHAR(36) NULL,

    INDEX `device_swaps_company_id_job_id_idx`(`company_id`, `job_id`),
    INDEX `device_swaps_old_device_id_idx`(`old_device_id`),
    INDEX `device_swaps_new_device_id_idx`(`new_device_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `role_limits` (
    `id` CHAR(36) NOT NULL,
    `company_id` CHAR(36) NOT NULL,
    `role` VARCHAR(50) NOT NULL,
    `type` ENUM('DISCOUNT', 'PRICE_ADJUSTMENT', 'PARTS_VARIANCE', 'WRITE_OFF', 'REFUND') NOT NULL,
    `max_amount` BIGINT NULL,
    `currency` CHAR(3) NULL,
    `max_percent` DECIMAL(6, 3) NULL,
    `enabled` BOOLEAN NOT NULL DEFAULT true,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    `created_by` CHAR(36) NULL,
    `updated_by` CHAR(36) NULL,

    INDEX `role_limits_company_id_role_idx`(`company_id`, `role`),
    UNIQUE INDEX `role_limits_company_id_role_type_key`(`company_id`, `role`, `type`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `job_collection_otps` (
    `id` CHAR(36) NOT NULL,
    `company_id` CHAR(36) NOT NULL,
    `branch_id` CHAR(36) NOT NULL,
    `job_id` CHAR(36) NOT NULL,
    `code_hash` VARCHAR(64) NOT NULL,
    `code_hint` CHAR(2) NOT NULL,
    `sent_to` VARCHAR(50) NULL,
    `sent_at` DATETIME(3) NULL,
    `expires_at` DATETIME(3) NOT NULL,
    `attempts` INTEGER NOT NULL DEFAULT 0,
    `verified_at` DATETIME(3) NULL,
    `verified_by` CHAR(36) NULL,
    `voided_at` DATETIME(3) NULL,
    `void_reason` VARCHAR(255) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    `created_by` CHAR(36) NULL,

    INDEX `job_collection_otps_company_id_job_id_created_at_idx`(`company_id`, `job_id`, `created_at`),
    INDEX `job_collection_otps_job_id_verified_at_voided_at_idx`(`job_id`, `verified_at`, `voided_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `consignments` (
    `id` CHAR(36) NOT NULL,
    `company_id` CHAR(36) NOT NULL,
    `consignment_no` VARCHAR(50) NOT NULL,
    `tote_label` VARCHAR(60) NOT NULL,
    `from_branch_id` CHAR(36) NOT NULL,
    `to_branch_id` CHAR(36) NOT NULL,
    `direction` ENUM('INBOUND_TO_HUB', 'OUTBOUND_TO_SPOKE') NOT NULL,
    `status` ENUM('OPEN', 'IN_TRANSIT', 'ARRIVED', 'CANCELLED') NOT NULL DEFAULT 'OPEN',
    `courier_name` VARCHAR(120) NULL,
    `courier_ref` VARCHAR(120) NULL,
    `waybill_no` VARCHAR(100) NULL,
    `sealed_at` DATETIME(3) NULL,
    `dispatched_at` DATETIME(3) NULL,
    `dispatched_by` CHAR(36) NULL,
    `arrived_at` DATETIME(3) NULL,
    `arrived_by` CHAR(36) NULL,
    `notes` TEXT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    `deleted_at` DATETIME(3) NULL,
    `created_by` CHAR(36) NULL,
    `updated_by` CHAR(36) NULL,

    INDEX `consignments_company_id_status_created_at_idx`(`company_id`, `status`, `created_at`),
    INDEX `consignments_company_id_tote_label_idx`(`company_id`, `tote_label`),
    UNIQUE INDEX `consignments_company_id_consignment_no_key`(`company_id`, `consignment_no`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `consignment_jobs` (
    `id` CHAR(36) NOT NULL,
    `company_id` CHAR(36) NOT NULL,
    `consignment_id` CHAR(36) NOT NULL,
    `job_id` CHAR(36) NOT NULL,
    `added_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `added_by` CHAR(36) NULL,
    `checked_in_at` DATETIME(3) NULL,
    `checked_in_by` CHAR(36) NULL,
    `note` VARCHAR(255) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    INDEX `consignment_jobs_company_id_job_id_idx`(`company_id`, `job_id`),
    UNIQUE INDEX `consignment_jobs_consignment_id_job_id_key`(`consignment_id`, `job_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `consignment_scans` (
    `id` CHAR(36) NOT NULL,
    `company_id` CHAR(36) NOT NULL,
    `consignment_id` CHAR(36) NOT NULL,
    `scan_point` ENUM('HUB_DEPART', 'COURIER_HUB', 'COURIER_DEPART', 'SPOKE_ARRIVE', 'HUB_ARRIVE', 'CUSTOM') NOT NULL,
    `location` VARCHAR(255) NULL,
    `scanned_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `scanned_by` CHAR(36) NULL,
    `handler_name` VARCHAR(120) NULL,
    `note` VARCHAR(500) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `consignment_scans_company_id_consignment_id_scanned_at_idx`(`company_id`, `consignment_id`, `scanned_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `consignment_counters` (
    `id` CHAR(36) NOT NULL,
    `company_id` CHAR(36) NOT NULL,
    `branch_id` CHAR(36) NOT NULL,
    `year` INTEGER NOT NULL,
    `next_seq` INTEGER NOT NULL DEFAULT 0,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `consignment_counters_company_id_branch_id_year_key`(`company_id`, `branch_id`, `year`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `csat_surveys` (
    `id` CHAR(36) NOT NULL,
    `company_id` CHAR(36) NOT NULL,
    `branch_id` CHAR(36) NOT NULL,
    `job_id` CHAR(36) NOT NULL,
    `customer_id` CHAR(36) NOT NULL,
    `token` VARCHAR(64) NOT NULL,
    `expires_at` DATETIME(3) NOT NULL,
    `sent_at` DATETIME(3) NULL,
    `score` TINYINT NULL,
    `comment` TEXT NULL,
    `responded_at` DATETIME(3) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    INDEX `csat_surveys_company_id_branch_id_responded_at_idx`(`company_id`, `branch_id`, `responded_at`),
    INDEX `csat_surveys_company_id_job_id_idx`(`company_id`, `job_id`),
    UNIQUE INDEX `csat_surveys_token_key`(`token`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `notification_templates` (
    `id` CHAR(36) NOT NULL,
    `company_id` CHAR(36) NOT NULL,
    `event_code` VARCHAR(60) NOT NULL,
    `channel` ENUM('SMS', 'EMAIL', 'WHATSAPP', 'IN_APP') NOT NULL,
    `language` ENUM('EN', 'SW') NOT NULL DEFAULT 'EN',
    `subject` VARCHAR(255) NULL,
    `body` TEXT NOT NULL,
    `active` BOOLEAN NOT NULL DEFAULT true,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    `deleted_at` DATETIME(3) NULL,
    `created_by` CHAR(36) NULL,
    `updated_by` CHAR(36) NULL,

    INDEX `notification_templates_company_id_event_code_idx`(`company_id`, `event_code`),
    UNIQUE INDEX `notification_templates_company_id_event_code_channel_languag_key`(`company_id`, `event_code`, `channel`, `language`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `notifications` (
    `id` CHAR(36) NOT NULL,
    `company_id` CHAR(36) NOT NULL,
    `branch_id` CHAR(36) NULL,
    `customer_id` CHAR(36) NULL,
    `job_id` CHAR(36) NULL,
    `user_id` CHAR(36) NULL,
    `event_code` VARCHAR(60) NOT NULL,
    `channel` ENUM('SMS', 'EMAIL', 'WHATSAPP', 'IN_APP') NOT NULL,
    `language` ENUM('EN', 'SW') NOT NULL DEFAULT 'EN',
    `to_address` VARCHAR(255) NOT NULL,
    `subject` VARCHAR(255) NULL,
    `body` TEXT NOT NULL,
    `payload` JSON NULL,
    `status` ENUM('QUEUED', 'SENDING', 'SENT', 'FAILED', 'CANCELLED') NOT NULL DEFAULT 'QUEUED',
    `attempts` INTEGER NOT NULL DEFAULT 0,
    `available_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `sent_at` DATETIME(3) NULL,
    `provider_ref` VARCHAR(255) NULL,
    `last_error` TEXT NULL,
    `leased_until` DATETIME(3) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    INDEX `notifications_status_available_at_idx`(`status`, `available_at`),
    INDEX `notifications_company_id_customer_id_created_at_idx`(`company_id`, `customer_id`, `created_at`),
    INDEX `notifications_company_id_job_id_created_at_idx`(`company_id`, `job_id`, `created_at`),
    INDEX `notifications_company_id_event_code_created_at_idx`(`company_id`, `event_code`, `created_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateIndex
CREATE INDEX `devices_replaced_by_device_id_idx` ON `devices`(`replaced_by_device_id`);

-- CreateIndex
CREATE INDEX `invoices_approval_token_hash_idx` ON `invoices`(`approval_token_hash`);

-- CreateIndex
CREATE INDEX `job_parts_part_unit_id_idx` ON `job_parts`(`part_unit_id`);

-- AddForeignKey
ALTER TABLE `jobs` ADD CONSTRAINT `jobs_symptom_node_id_fkey` FOREIGN KEY (`symptom_node_id`) REFERENCES `symptom_nodes`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `jobs` ADD CONSTRAINT `jobs_condition_captured_by_fkey` FOREIGN KEY (`condition_captured_by`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `jobs` ADD CONSTRAINT `jobs_qc_approved_by_fkey` FOREIGN KEY (`qc_approved_by`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `job_parts` ADD CONSTRAINT `job_parts_issued_by_fkey` FOREIGN KEY (`issued_by`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `job_parts` ADD CONSTRAINT `job_parts_core_returned_by_fkey` FOREIGN KEY (`core_returned_by`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `symptom_nodes` ADD CONSTRAINT `symptom_nodes_company_id_fkey` FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `symptom_nodes` ADD CONSTRAINT `symptom_nodes_parent_id_fkey` FOREIGN KEY (`parent_id`) REFERENCES `symptom_nodes`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `symptom_nodes` ADD CONSTRAINT `symptom_nodes_fault_code_id_fkey` FOREIGN KEY (`fault_code_id`) REFERENCES `fault_codes`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `symptom_nodes` ADD CONSTRAINT `symptom_nodes_service_category_id_fkey` FOREIGN KEY (`service_category_id`) REFERENCES `service_categories`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `symptom_nodes` ADD CONSTRAINT `symptom_nodes_created_by_fkey` FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `symptom_nodes` ADD CONSTRAINT `symptom_nodes_updated_by_fkey` FOREIGN KEY (`updated_by`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `condition_zones` ADD CONSTRAINT `condition_zones_company_id_fkey` FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `condition_zones` ADD CONSTRAINT `condition_zones_created_by_fkey` FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `condition_zones` ADD CONSTRAINT `condition_zones_updated_by_fkey` FOREIGN KEY (`updated_by`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `job_condition_marks` ADD CONSTRAINT `job_condition_marks_company_id_fkey` FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `job_condition_marks` ADD CONSTRAINT `job_condition_marks_job_id_fkey` FOREIGN KEY (`job_id`) REFERENCES `jobs`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `job_condition_marks` ADD CONSTRAINT `job_condition_marks_zone_id_fkey` FOREIGN KEY (`zone_id`) REFERENCES `condition_zones`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `job_condition_marks` ADD CONSTRAINT `job_condition_marks_created_by_fkey` FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `job_condition_marks` ADD CONSTRAINT `job_condition_marks_updated_by_fkey` FOREIGN KEY (`updated_by`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `user_skills` ADD CONSTRAINT `user_skills_company_id_fkey` FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `user_skills` ADD CONSTRAINT `user_skills_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `user_skills` ADD CONSTRAINT `user_skills_service_category_id_fkey` FOREIGN KEY (`service_category_id`) REFERENCES `service_categories`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `user_skills` ADD CONSTRAINT `user_skills_created_by_fkey` FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `user_skills` ADD CONSTRAINT `user_skills_updated_by_fkey` FOREIGN KEY (`updated_by`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `job_state_events` ADD CONSTRAINT `job_state_events_company_id_fkey` FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `job_state_events` ADD CONSTRAINT `job_state_events_branch_id_fkey` FOREIGN KEY (`branch_id`) REFERENCES `branches`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `job_state_events` ADD CONSTRAINT `job_state_events_job_id_fkey` FOREIGN KEY (`job_id`) REFERENCES `jobs`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `job_state_events` ADD CONSTRAINT `job_state_events_state_id_fkey` FOREIGN KEY (`state_id`) REFERENCES `workflow_states`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `qc_checklist_items` ADD CONSTRAINT `qc_checklist_items_company_id_fkey` FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `qc_checklist_items` ADD CONSTRAINT `qc_checklist_items_created_by_fkey` FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `qc_checklist_items` ADD CONSTRAINT `qc_checklist_items_updated_by_fkey` FOREIGN KEY (`updated_by`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `job_qc_checks` ADD CONSTRAINT `job_qc_checks_company_id_fkey` FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `job_qc_checks` ADD CONSTRAINT `job_qc_checks_job_id_fkey` FOREIGN KEY (`job_id`) REFERENCES `jobs`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `job_qc_checks` ADD CONSTRAINT `job_qc_checks_item_id_fkey` FOREIGN KEY (`item_id`) REFERENCES `qc_checklist_items`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `job_qc_checks` ADD CONSTRAINT `job_qc_checks_recorded_by_fkey` FOREIGN KEY (`recorded_by`) REFERENCES `users`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ber_assessments` ADD CONSTRAINT `ber_assessments_company_id_fkey` FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ber_assessments` ADD CONSTRAINT `ber_assessments_branch_id_fkey` FOREIGN KEY (`branch_id`) REFERENCES `branches`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ber_assessments` ADD CONSTRAINT `ber_assessments_job_id_fkey` FOREIGN KEY (`job_id`) REFERENCES `jobs`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ber_assessments` ADD CONSTRAINT `ber_assessments_reviewed_by_fkey` FOREIGN KEY (`reviewed_by`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ber_assessments` ADD CONSTRAINT `ber_assessments_created_by_fkey` FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ber_assessments` ADD CONSTRAINT `ber_assessments_updated_by_fkey` FOREIGN KEY (`updated_by`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `swap_units` ADD CONSTRAINT `swap_units_company_id_fkey` FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `swap_units` ADD CONSTRAINT `swap_units_branch_id_fkey` FOREIGN KEY (`branch_id`) REFERENCES `branches`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `swap_units` ADD CONSTRAINT `swap_units_model_id_fkey` FOREIGN KEY (`model_id`) REFERENCES `models`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `swap_units` ADD CONSTRAINT `swap_units_issued_by_fkey` FOREIGN KEY (`issued_by`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `swap_units` ADD CONSTRAINT `swap_units_created_by_fkey` FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `swap_units` ADD CONSTRAINT `swap_units_updated_by_fkey` FOREIGN KEY (`updated_by`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `device_swaps` ADD CONSTRAINT `device_swaps_company_id_fkey` FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `device_swaps` ADD CONSTRAINT `device_swaps_branch_id_fkey` FOREIGN KEY (`branch_id`) REFERENCES `branches`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `device_swaps` ADD CONSTRAINT `device_swaps_job_id_fkey` FOREIGN KEY (`job_id`) REFERENCES `jobs`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `device_swaps` ADD CONSTRAINT `device_swaps_old_device_id_fkey` FOREIGN KEY (`old_device_id`) REFERENCES `devices`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `device_swaps` ADD CONSTRAINT `device_swaps_new_device_id_fkey` FOREIGN KEY (`new_device_id`) REFERENCES `devices`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `device_swaps` ADD CONSTRAINT `device_swaps_swap_unit_id_fkey` FOREIGN KEY (`swap_unit_id`) REFERENCES `swap_units`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `device_swaps` ADD CONSTRAINT `device_swaps_ber_assessment_id_fkey` FOREIGN KEY (`ber_assessment_id`) REFERENCES `ber_assessments`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `device_swaps` ADD CONSTRAINT `device_swaps_authorized_by_fkey` FOREIGN KEY (`authorized_by`) REFERENCES `users`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `device_swaps` ADD CONSTRAINT `device_swaps_created_by_fkey` FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `role_limits` ADD CONSTRAINT `role_limits_company_id_fkey` FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `role_limits` ADD CONSTRAINT `role_limits_created_by_fkey` FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `role_limits` ADD CONSTRAINT `role_limits_updated_by_fkey` FOREIGN KEY (`updated_by`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `job_collection_otps` ADD CONSTRAINT `job_collection_otps_company_id_fkey` FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `job_collection_otps` ADD CONSTRAINT `job_collection_otps_branch_id_fkey` FOREIGN KEY (`branch_id`) REFERENCES `branches`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `job_collection_otps` ADD CONSTRAINT `job_collection_otps_job_id_fkey` FOREIGN KEY (`job_id`) REFERENCES `jobs`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `job_collection_otps` ADD CONSTRAINT `job_collection_otps_verified_by_fkey` FOREIGN KEY (`verified_by`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `job_collection_otps` ADD CONSTRAINT `job_collection_otps_created_by_fkey` FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `consignments` ADD CONSTRAINT `consignments_company_id_fkey` FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `consignments` ADD CONSTRAINT `consignments_from_branch_id_fkey` FOREIGN KEY (`from_branch_id`) REFERENCES `branches`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `consignments` ADD CONSTRAINT `consignments_to_branch_id_fkey` FOREIGN KEY (`to_branch_id`) REFERENCES `branches`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `consignments` ADD CONSTRAINT `consignments_dispatched_by_fkey` FOREIGN KEY (`dispatched_by`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `consignments` ADD CONSTRAINT `consignments_arrived_by_fkey` FOREIGN KEY (`arrived_by`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `consignments` ADD CONSTRAINT `consignments_created_by_fkey` FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `consignments` ADD CONSTRAINT `consignments_updated_by_fkey` FOREIGN KEY (`updated_by`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `consignment_jobs` ADD CONSTRAINT `consignment_jobs_company_id_fkey` FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `consignment_jobs` ADD CONSTRAINT `consignment_jobs_consignment_id_fkey` FOREIGN KEY (`consignment_id`) REFERENCES `consignments`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `consignment_jobs` ADD CONSTRAINT `consignment_jobs_job_id_fkey` FOREIGN KEY (`job_id`) REFERENCES `jobs`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `consignment_jobs` ADD CONSTRAINT `consignment_jobs_added_by_fkey` FOREIGN KEY (`added_by`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `consignment_jobs` ADD CONSTRAINT `consignment_jobs_checked_in_by_fkey` FOREIGN KEY (`checked_in_by`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `consignment_scans` ADD CONSTRAINT `consignment_scans_company_id_fkey` FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `consignment_scans` ADD CONSTRAINT `consignment_scans_consignment_id_fkey` FOREIGN KEY (`consignment_id`) REFERENCES `consignments`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `consignment_scans` ADD CONSTRAINT `consignment_scans_scanned_by_fkey` FOREIGN KEY (`scanned_by`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `csat_surveys` ADD CONSTRAINT `csat_surveys_company_id_fkey` FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `csat_surveys` ADD CONSTRAINT `csat_surveys_branch_id_fkey` FOREIGN KEY (`branch_id`) REFERENCES `branches`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `csat_surveys` ADD CONSTRAINT `csat_surveys_job_id_fkey` FOREIGN KEY (`job_id`) REFERENCES `jobs`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `csat_surveys` ADD CONSTRAINT `csat_surveys_customer_id_fkey` FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `notification_templates` ADD CONSTRAINT `notification_templates_company_id_fkey` FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `notification_templates` ADD CONSTRAINT `notification_templates_created_by_fkey` FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `notification_templates` ADD CONSTRAINT `notification_templates_updated_by_fkey` FOREIGN KEY (`updated_by`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `notifications` ADD CONSTRAINT `notifications_company_id_fkey` FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `notifications` ADD CONSTRAINT `notifications_branch_id_fkey` FOREIGN KEY (`branch_id`) REFERENCES `branches`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `notifications` ADD CONSTRAINT `notifications_customer_id_fkey` FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `notifications` ADD CONSTRAINT `notifications_job_id_fkey` FOREIGN KEY (`job_id`) REFERENCES `jobs`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- BACKFILL (SCMS proposal Module 2)
--
-- `workflow_states.stage` / `hold_kind` / `pauses_sla` default to
-- INTAKE/NONE/false, which is wrong for every state a live company already
-- has. Classify the seeded default lifecycle (§5) by CODE here so the KPI
-- clocks are correct the moment this migration lands; states a company added
-- itself keep the defaults and are reclassified from the workflow admin
-- screen. Matching on code (not id) is deliberate — it works for every
-- tenant in the database, including ones created after the seed.
-- ---------------------------------------------------------------------------
UPDATE `workflow_states` SET `stage` = 'INTAKE'    WHERE `code` = 'RECEIVED';
UPDATE `workflow_states` SET `stage` = 'DIAGNOSIS' WHERE `code` = 'DIAGNOSING';
UPDATE `workflow_states` SET `stage` = 'REPAIR'    WHERE `code` = 'IN_REPAIR';
UPDATE `workflow_states` SET `stage` = 'QC'        WHERE `code` = 'QC';
UPDATE `workflow_states` SET `stage` = 'READY'     WHERE `code` = 'READY';
UPDATE `workflow_states` SET `stage` = 'DONE'
  WHERE `code` IN ('DISPATCHED', 'CLOSED', 'CANCELLED', 'RETURNED_UNREPAIRED');

-- Hold states: the customer-facing SLA stops, the internal clock does not.
UPDATE `workflow_states`
   SET `stage` = 'HOLD', `hold_kind` = 'PARTS', `pauses_sla` = 1
 WHERE `code` = 'AWAITING_PARTS';
UPDATE `workflow_states`
   SET `stage` = 'HOLD', `hold_kind` = 'CUSTOMER', `pauses_sla` = 1
 WHERE `code` = 'AWAITING_CUSTOMER_APPROVAL';

-- ---------------------------------------------------------------------------
-- Open a state-event row for every job already in flight, so the SLA/KPI
-- clocks have a starting point instead of reporting "no data" for the whole
-- existing backlog. `entered_at` is the best evidence available: when the job
-- last changed (updated_at), floored at intake (received_at) — a job cannot
-- have entered its current state before it arrived. Historical occupancies
-- before this migration are genuinely unknown and are NOT invented; the KPI
-- reports simply have no rows for them.
-- ---------------------------------------------------------------------------
INSERT INTO `job_state_events`
  (`id`, `company_id`, `branch_id`, `job_id`, `state_id`, `from_state_id`,
   `stage`, `hold_kind`, `pauses_sla`, `entered_at`, `engineer_id`, `note`,
   `created_at`)
SELECT
  UUID(), j.`company_id`, j.`branch_id`, j.`id`, j.`state_id`, NULL,
  s.`stage`, s.`hold_kind`, s.`pauses_sla`,
  GREATEST(j.`received_at`, j.`updated_at`), j.`assigned_engineer_id`,
  'Opened by the SCMS migration — occupancy before this point is unrecorded',
  NOW(3)
FROM `jobs` j
JOIN `workflow_states` s ON s.`id` = j.`state_id`
WHERE j.`deleted_at` IS NULL
  AND s.`is_terminal` = 0;

-- Terminal jobs get a CLOSED occupancy so turnaround reports can still see
-- them, closed at the moment they finished.
INSERT INTO `job_state_events`
  (`id`, `company_id`, `branch_id`, `job_id`, `state_id`, `from_state_id`,
   `stage`, `hold_kind`, `pauses_sla`, `entered_at`, `exited_at`, `duration_ms`,
   `engineer_id`, `note`, `created_at`)
SELECT
  UUID(), j.`company_id`, j.`branch_id`, j.`id`, j.`state_id`, NULL,
  s.`stage`, s.`hold_kind`, s.`pauses_sla`,
  COALESCE(j.`dispatched_at`, j.`ready_at`, j.`updated_at`),
  COALESCE(j.`dispatched_at`, j.`ready_at`, j.`updated_at`), 0,
  j.`assigned_engineer_id`,
  'Closed by the SCMS migration — occupancy before this point is unrecorded',
  NOW(3)
FROM `jobs` j
JOIN `workflow_states` s ON s.`id` = j.`state_id`
WHERE j.`deleted_at` IS NULL
  AND s.`is_terminal` = 1;
