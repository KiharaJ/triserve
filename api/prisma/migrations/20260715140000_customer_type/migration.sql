-- Customer classification (§4.2): 3-way type, derived is_dealer stays in sync.

-- AlterTable
ALTER TABLE `customers` ADD COLUMN `customer_type` ENUM('INDIVIDUAL', 'BUSINESS', 'DEALER') NOT NULL DEFAULT 'INDIVIDUAL';

-- Backfill: existing dealers become DEALER; everyone else stays INDIVIDUAL.
UPDATE `customers` SET `customer_type` = 'DEALER' WHERE `is_dealer` = true;
