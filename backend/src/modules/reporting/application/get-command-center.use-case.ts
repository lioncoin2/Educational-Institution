import { Inject, Injectable } from '@nestjs/common';

import { ok, type Principal, type Result } from '../../../shared';
import {
  AUTHORIZATION_SERVICE,
  type AuthorizationService,
} from '../../identity/contracts/authorization';
import { Permissions, type Permission } from '../../identity/contracts/permissions';
import {
  COMMAND_ACTIONS,
  WIDGET_PROVIDERS,
  type CommandActionDescriptor,
  type WidgetData,
  type WidgetDescriptor,
  type WidgetProvider,
} from '../contracts';

/** One resolved widget: its descriptor (presentation) and its data (facts). */
export interface CommandCenterWidget {
  readonly descriptor: WidgetDescriptor;
  readonly data: WidgetData;
}

export interface CommandCenter {
  readonly widgets: readonly CommandCenterWidget[];
  /** Quick actions to real operations the viewer may perform. */
  readonly actions: readonly CommandActionDescriptor[];
}

/**
 * The Owner Command Center: the registered widgets the viewer may see, each
 * resolved to its current facts, plus the quick actions they may perform.
 *
 * Authorization is the server's, twice: the edge requires `reports.read`, and
 * this use case re-checks it, then — per the registries' contract — hides any
 * widget OR action whose `requiredPermission` the viewer does not hold (the UI
 * is never the boundary; an action re-authorizes again when invoked). A build
 * with no widgets registered answers an empty set, never an error. Nothing here
 * invents a metric: a widget shows only what its provider read from an
 * already-authorized source, and an action only links an already-built one.
 */
@Injectable()
export class GetCommandCenterUseCase {
  constructor(
    @Inject(AUTHORIZATION_SERVICE) private readonly authorization: AuthorizationService,
    @Inject(WIDGET_PROVIDERS) private readonly providers: readonly WidgetProvider[],
    @Inject(COMMAND_ACTIONS) private readonly actionCatalog: readonly CommandActionDescriptor[],
  ) {}

  async execute(command: { principal: Principal }): Promise<Result<CommandCenter>> {
    const allowed = this.authorization.authorize(command.principal, Permissions.reports.read);
    if (!allowed.ok) return allowed;

    const widgets: CommandCenterWidget[] = [];
    for (const provider of this.providers) {
      const permission = provider.descriptor.requiredPermission as Permission;
      if (!this.authorization.can(command.principal, permission)) continue;
      widgets.push({
        descriptor: provider.descriptor,
        data: await provider.resolve(command.principal.userId),
      });
    }

    const actions = this.actionCatalog.filter((action) =>
      this.authorization.can(command.principal, action.requiredPermission as Permission),
    );

    return ok({ widgets, actions });
  }
}
