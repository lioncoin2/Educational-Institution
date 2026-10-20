import type { CommandCenter } from '../application/get-command-center.use-case';

/**
 * Wire shapes for the Owner Command Center. Each widget carries its id, its
 * category and title (presentation the server owns), and an opaque `payload`
 * the client renders as given. `requiredPermission` is NOT on the wire — the
 * server has already filtered to what the viewer may see.
 */
export interface CommandCenterWidgetResponse {
  readonly id: string;
  readonly category: string;
  readonly title: string;
  readonly payload: Readonly<Record<string, unknown>>;
}

/** A quick action the viewer may perform. `requiredPermission` is NOT on the wire. */
export interface CommandActionResponse {
  readonly id: string;
  readonly title: string;
}

export interface CommandCenterResponse {
  readonly widgets: readonly CommandCenterWidgetResponse[];
  readonly actions: readonly CommandActionResponse[];
}

export function toCommandCenterResponse(view: CommandCenter): CommandCenterResponse {
  return {
    widgets: view.widgets.map((widget) => ({
      id: widget.descriptor.id,
      category: widget.descriptor.category,
      title: widget.descriptor.title,
      payload: widget.data.payload,
    })),
    actions: view.actions.map((action) => ({ id: action.id, title: action.title })),
  };
}
