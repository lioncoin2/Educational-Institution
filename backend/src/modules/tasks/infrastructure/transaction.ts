import type { Database } from '../../../platform/database';

/** A Drizzle transaction handle, and anything a statement can run on. */
export type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];
export type Executor = Database | Transaction;
