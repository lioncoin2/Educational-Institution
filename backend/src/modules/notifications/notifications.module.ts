import { Module } from '@nestjs/common';

/**
 * Notifications — boundary only.
 *
 * Its responsibility, owned entities, public contracts, events, dependencies and
 * what it must not know are specified in
 * docs/architecture/module-boundaries.md. No behaviour is implemented yet: this
 * milestone establishes the boundary, not the feature.
 */
@Module({})
export class NotificationsModule {}
