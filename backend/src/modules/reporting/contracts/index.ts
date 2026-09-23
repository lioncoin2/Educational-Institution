/**
 * Reporting — read models and the Owner Command Center.
 *
 * The dashboard is a registry, not a screen: a module contributes a widget by
 * registering a descriptor and a resolver. Adding "pending decisions" later
 * means registering one more widget, never editing a dashboard component — which
 * is the requirement that the command centre must grow without being rewritten.
 */
export type WidgetCategory =
  'today' | 'attention' | 'pending_decisions' | 'quick_actions' | 'activity' | 'kpi';

export interface WidgetDescriptor {
  readonly id: string;
  readonly category: WidgetCategory;
  readonly title: string;
  /** Permission the viewer needs; the dashboard hides what they may not see. */
  readonly requiredPermission: string;
}

export interface WidgetData {
  readonly widgetId: string;
  readonly payload: Readonly<Record<string, unknown>>;
}

/** Implemented by any module that contributes to the command centre. */
export interface WidgetProvider {
  readonly descriptor: WidgetDescriptor;
  resolve(viewerUserId: string): Promise<WidgetData>;
}

export const WIDGET_PROVIDERS = Symbol('WIDGET_PROVIDERS');
