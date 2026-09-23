/**
 * Notifications — a person's inbox of things that happened to them, and the
 * delivery of each to wherever they are.
 *
 * Other modules never create a notification and never talk to a push
 * service. They publish their own domain events; a translator inside this
 * module decides which facts deserve a notification and for whom, and the
 * dispatcher stores each one once. Delivery — live to a connected app, push
 * to a device — follows from `notifications.notification.created`.
 *
 * The public surface is what delivery modules and clients need: the
 * vocabulary, the target shapes, the events, and the reader realtime uses to
 * render a notification it was told about.
 */
export * from './events';
export * from './notification-reader';
export * from './targets';
export * from './vocabulary';
