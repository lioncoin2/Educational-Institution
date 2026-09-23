/**
 * Communities' public surface: the act vocabulary, the four questions other
 * modules may ask (may this principal act here? who belongs? who holds a
 * capability? what is it called?) and the facts it publishes. Other modules
 * reference a community by id and never read Communities' tables.
 */
export * from './authorization';
export * from './capabilities';
export * from './capability-holders';
export * from './directory';
export * from './events';
export * from './membership';
export * from './vocabulary';
