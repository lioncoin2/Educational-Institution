/**
 * DI tokens for the kernel ports.
 *
 * They live in the shared kernel, not in platform, so an application layer can
 * ask for a Clock or an EventPublisher without importing infrastructure. Platform
 * supplies the implementations; nobody else needs to know which.
 */
export const CLOCK = Symbol('CLOCK');
export const ID_GENERATOR = Symbol('ID_GENERATOR');
export const EVENT_PUBLISHER = Symbol('EVENT_PUBLISHER');
export const EVENT_SUBSCRIBER = Symbol('EVENT_SUBSCRIBER');
