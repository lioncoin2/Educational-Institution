import { Module } from '@nestjs/common';

import { IdentityModule } from '../identity/identity.module';
import { SearchPeopleUseCase } from './application/search-people.use-case';
import { SearchTeachersUseCase } from './application/search-teachers.use-case';
import { PeopleController } from './api/people.controller';

/**
 * People — the human record behind a login.
 *
 * Its responsibility, owned entities, public contracts, events, dependencies
 * and what it must not know are specified in
 * docs/architecture/module-boundaries.md. First behaviour (Owner Decision
 * A1/A4): `GET /people`, a display-name search gated on `people.read`; and
 * (Q6) `GET /people/teachers`, a teacher-only directory gated on a student's
 * `messaging.start_direct_teacher`. Both consume identity's `ACCOUNT_SEARCH`
 * (the data) and `AUTHORIZATION_SERVICE` (the decision) through `IdentityModule`;
 * it owns no table and, being a leaf, exports nothing.
 */
@Module({
  imports: [IdentityModule],
  controllers: [PeopleController],
  providers: [SearchPeopleUseCase, SearchTeachersUseCase],
})
export class PeopleModule {}
