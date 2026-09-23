import type { UserRepository } from '../domain/ports';
import type { User, UserId } from '../domain/user';

/**
 * Foundation adapter.
 *
 * The persistence *port* is what the domain and use cases depend on, so the
 * Postgres/Drizzle adapter can replace this without touching a use case. Keeping
 * an in-memory implementation permanently is also what lets the whole identity
 * slice be tested without a database.
 */
export class InMemoryUserRepository implements UserRepository {
  private readonly byId = new Map<string, User>();

  constructor(seed: readonly User[] = []) {
    for (const user of seed) this.byId.set(user.id, user);
  }

  async findById(id: UserId): Promise<User | null> {
    return this.byId.get(id) ?? null;
  }

  async findByEmail(email: string): Promise<User | null> {
    const needle = email.trim().toLowerCase();
    for (const user of this.byId.values()) {
      if (user.email.toLowerCase() === needle) return user;
    }
    return null;
  }

  async save(user: User): Promise<void> {
    this.byId.set(user.id, user);
  }
}
