/**
 * The values identity's use cases accept, published for the transport edge.
 *
 * The API layer may not import the domain (dependency-rules.md), but its
 * validators must accept exactly what the use cases accept. Re-exporting the
 * vocabulary here makes the application layer the one contract both sides
 * read, instead of two copies that drift.
 */
export { ALL_ACCOUNT_STATUSES, type AccountStatus } from '../domain/account-status';
export { DEVICE_PLATFORMS, type DevicePlatform } from '../domain/auth-session';
export { IDENTIFIER_KINDS, type IdentifierKind } from '../domain/login-identifier';
export { ROLE_CODE_SHAPE } from '../domain/role';
