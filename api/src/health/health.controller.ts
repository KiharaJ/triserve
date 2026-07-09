import { Controller, Get } from '@nestjs/common';
import type { HealthResponse } from '@triserve/shared';
import { PrismaService } from '../prisma/prisma.service';

@Controller('health')
export class HealthController {
  constructor(private readonly prisma: PrismaService) {}

  /** GET /api/v1/health */
  @Get()
  async check(): Promise<HealthResponse> {
    let db: HealthResponse['db'] = 'down';
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      db = 'up';
    } catch {
      db = 'down';
    }

    return {
      status: 'ok',
      service: 'triserve-api',
      version: '0.1.0',
      time: new Date().toISOString(),
      db,
    };
  }
}
