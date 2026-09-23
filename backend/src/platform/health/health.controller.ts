import { Controller, Get } from '@nestjs/common';

import { PublicRoute } from '../http/public-route.decorator';

/**
 * Liveness and readiness.
 *
 * Deliberately dependency-free at this stage: it reports that the process is up
 * and serving. Readiness will grow real checks (database, redis, LiveKit
 * reachability) as those adapters gain live connections — see
 * docs/architecture/open-questions.md.
 */
@Controller('health')
export class HealthController {
  private readonly startedAt = Date.now();

  @Get('live')
  @PublicRoute()
  live(): { status: 'ok' } {
    return { status: 'ok' };
  }

  @Get('ready')
  @PublicRoute()
  ready(): { status: 'ok'; uptimeSeconds: number } {
    return { status: 'ok', uptimeSeconds: Math.floor((Date.now() - this.startedAt) / 1000) };
  }
}
