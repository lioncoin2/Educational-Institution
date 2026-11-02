/**
 * Tasks — the daily tasks & reports engine (ADR 0052). Its only public surface is
 * its events; no other module reads its tables or calls its use cases.
 */
export * from './events';
