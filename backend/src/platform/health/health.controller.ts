import { Controller, Get } from '@nestjs/common';

import { PublicRoute } from '../http/public-route.decorator';

/**
 * Liveness and readiness.
 *
 * Deliberately dependency-free at this stage: it reports that the process is up
 * and serving. Readiness should check the database pool and Redis before
 * production — listed as debt in docs/architecture/observability.md §3. The
 * media provider's readiness is not for this route: it stays inside live, where
 * it gates Start (P7.1, decision 7; docs/p7-livekit-readiness.md §15).
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
