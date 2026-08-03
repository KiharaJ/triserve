import { Global, Logger, Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import type { NotificationChannel } from '@prisma/client';
import { AuthModule } from '../auth/auth.module';
import { HttpSmsDriver } from './drivers/http-sms.driver';
import { LogNotificationDriver } from './drivers/log.driver';
import { NotificationWorkerService } from './notification-worker.service';
import {
  NOTIFICATION_DRIVERS,
  type NotificationDriver,
} from './notification.types';
import { NotificationsController } from './notifications.controller';
import { NotificationsService } from './notifications.service';

/**
 * NotificationsModule (SCMS proposal Module 7; DESIGN.md §4.13/E6).
 *
 * GLOBAL because nearly every operational module publishes events — jobs,
 * invoices, logistics, BER. Exporting it from each importer's module list
 * instead would mean threading the same import through a dozen files to say
 * the same thing.
 *
 * Driver selection is env-driven, exactly like STORAGE_DRIVER:
 *
 *   SMS_DRIVER=log   (default) — logs the message, marks it sent
 *   SMS_DRIVER=http            — POSTs JSON to SMS_URL (Beem / Africa's
 *                                Talking / NextSMS style gateways)
 *
 * Switching to a real gateway is an env change, not a code change.
 */
@Global()
@Module({
  imports: [ConfigModule, AuthModule],
  controllers: [NotificationsController],
  providers: [
    NotificationsService,
    NotificationWorkerService,
    {
      provide: NOTIFICATION_DRIVERS,
      inject: [ConfigService],
      useFactory: (
        config: ConfigService,
      ): Map<NotificationChannel, NotificationDriver> => {
        const logger = new Logger('NotificationsModule');
        const drivers = new Map<NotificationChannel, NotificationDriver>();

        const smsDriver = String(config.get('SMS_DRIVER') ?? 'log');
        if (smsDriver === 'http') {
          const url = config.get<string>('SMS_URL');
          if (!url) {
            // Falling back silently would be worse than the stub: an operator
            // who set SMS_DRIVER=http believes real messages are going out.
            // Say so, loudly, and keep the pipeline running on the stub.
            logger.error(
              'SMS_DRIVER=http but SMS_URL is not set — falling back to the LOG stub. No real SMS will be sent.',
            );
            drivers.set('SMS', new LogNotificationDriver('SMS'));
          } else {
            drivers.set(
              'SMS',
              new HttpSmsDriver('SMS', {
                url,
                apiKey: config.get('SMS_API_KEY'),
                authScheme: config.get('SMS_AUTH_SCHEME') ?? 'Bearer',
                senderId: config.get('SMS_SENDER_ID'),
                toField: config.get('SMS_FIELD_TO') ?? 'recipient',
                bodyField: config.get('SMS_FIELD_BODY') ?? 'message',
                senderField: config.get('SMS_FIELD_SENDER') ?? 'source_addr',
                refPath: config.get('SMS_REF_PATH') ?? undefined,
                timeoutMs: Number(config.get('SMS_TIMEOUT_MS') ?? 15_000),
              }),
            );
            logger.log(`SMS driver: http → ${url}`);
          }
        } else {
          drivers.set('SMS', new LogNotificationDriver('SMS'));
          if (config.get('NODE_ENV') === 'production') {
            logger.warn(
              'SMS_DRIVER is the LOG stub in production — customers will NOT receive collection PINs or quote links. Set SMS_DRIVER=http.',
            );
          }
        }

        // EMAIL and WHATSAPP have no configured provider yet; the stub keeps
        // the outbox honest (rows render, queue, and are marked sent) so
        // adding a real driver later is one entry in this map.
        drivers.set('EMAIL', new LogNotificationDriver('EMAIL'));
        drivers.set('WHATSAPP', new LogNotificationDriver('WHATSAPP'));
        drivers.set('IN_APP', new LogNotificationDriver('IN_APP'));

        return drivers;
      },
    },
  ],
  exports: [NotificationsService, NotificationWorkerService],
})
export class NotificationsModule {}
