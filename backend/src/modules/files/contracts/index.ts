export * from './file-kind';

/** DI token for the storage port. Public so any module can inject storage. */
export const STORAGE_PROVIDER = Symbol('STORAGE_PROVIDER');
