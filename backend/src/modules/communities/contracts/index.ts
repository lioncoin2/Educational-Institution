/**
 * Communities' public surface: the act vocabulary, the three questions other
 * modules may ask (may this principal act here? who belongs? what is it
 * called?) and the facts it publishes. Other modules reference a community by
 * id and never read Communities' tables.
 */
export * from './authorization';
export * from './capabilities';
export * from './directory';
export * from './events';
export * from './membership';
export * from './vocabulary';
