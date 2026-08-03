-- DropForeignKey
ALTER TABLE `ber_assessments` DROP FOREIGN KEY `ber_assessments_job_id_fkey`;

-- DropForeignKey
ALTER TABLE `consignment_jobs` DROP FOREIGN KEY `consignment_jobs_consignment_id_fkey`;

-- DropForeignKey
ALTER TABLE `consignment_jobs` DROP FOREIGN KEY `consignment_jobs_job_id_fkey`;

-- DropForeignKey
ALTER TABLE `consignment_scans` DROP FOREIGN KEY `consignment_scans_consignment_id_fkey`;

-- DropForeignKey
ALTER TABLE `csat_surveys` DROP FOREIGN KEY `csat_surveys_job_id_fkey`;

-- DropForeignKey
ALTER TABLE `device_swaps` DROP FOREIGN KEY `device_swaps_job_id_fkey`;

-- DropForeignKey
ALTER TABLE `job_collection_otps` DROP FOREIGN KEY `job_collection_otps_job_id_fkey`;

-- DropForeignKey
ALTER TABLE `job_condition_marks` DROP FOREIGN KEY `job_condition_marks_job_id_fkey`;

-- DropForeignKey
ALTER TABLE `job_qc_checks` DROP FOREIGN KEY `job_qc_checks_job_id_fkey`;

-- DropForeignKey
ALTER TABLE `job_state_events` DROP FOREIGN KEY `job_state_events_job_id_fkey`;

-- DropIndex
DROP INDEX `ber_assessments_job_id_fkey` ON `ber_assessments`;

-- DropIndex
DROP INDEX `consignment_jobs_job_id_fkey` ON `consignment_jobs`;

-- DropIndex
DROP INDEX `consignment_scans_consignment_id_fkey` ON `consignment_scans`;

-- DropIndex
DROP INDEX `csat_surveys_job_id_fkey` ON `csat_surveys`;

-- DropIndex
DROP INDEX `device_swaps_job_id_fkey` ON `device_swaps`;

-- AddForeignKey
ALTER TABLE `job_condition_marks` ADD CONSTRAINT `job_condition_marks_job_id_fkey` FOREIGN KEY (`job_id`) REFERENCES `jobs`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `job_state_events` ADD CONSTRAINT `job_state_events_job_id_fkey` FOREIGN KEY (`job_id`) REFERENCES `jobs`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `job_qc_checks` ADD CONSTRAINT `job_qc_checks_job_id_fkey` FOREIGN KEY (`job_id`) REFERENCES `jobs`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ber_assessments` ADD CONSTRAINT `ber_assessments_job_id_fkey` FOREIGN KEY (`job_id`) REFERENCES `jobs`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `device_swaps` ADD CONSTRAINT `device_swaps_job_id_fkey` FOREIGN KEY (`job_id`) REFERENCES `jobs`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `job_collection_otps` ADD CONSTRAINT `job_collection_otps_job_id_fkey` FOREIGN KEY (`job_id`) REFERENCES `jobs`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `consignment_jobs` ADD CONSTRAINT `consignment_jobs_consignment_id_fkey` FOREIGN KEY (`consignment_id`) REFERENCES `consignments`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `consignment_jobs` ADD CONSTRAINT `consignment_jobs_job_id_fkey` FOREIGN KEY (`job_id`) REFERENCES `jobs`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `consignment_scans` ADD CONSTRAINT `consignment_scans_consignment_id_fkey` FOREIGN KEY (`consignment_id`) REFERENCES `consignments`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `csat_surveys` ADD CONSTRAINT `csat_surveys_job_id_fkey` FOREIGN KEY (`job_id`) REFERENCES `jobs`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
