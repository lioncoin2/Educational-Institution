import { Module } from '@nestjs/common';

import { FilesModule } from '../files/files.module';
import { IdentityModule } from '../identity/identity.module';
import { GetPersonAvatarLinkUseCase } from './application/get-person-avatar-link.use-case';
import { SearchPeopleUseCase } from './application/search-people.use-case';
import { SearchTeachersUseCase } from './application/search-teachers.use-case';
import { PeopleController } from './api/people.controller';

/**
 * People — the human record behind a login.
 *
 * Its responsibility, owned entities, public contracts, events, dependencies
 * and what it must not know are specified in
 * docs/architecture/module-boundaries.md. First behaviour (Owner Decision
 * A1/A4): `GET /people`, a display-name search gated on `people.read`
 * (OWNER/ADMIN only since migration 0020; the owner/admin membership-management
 * directory — ADR 0032); and (Q6) `GET /people/teachers`, a teacher-only
 * directory gated on a student's `messaging.start_direct_teacher`. Both consume
 * identity's `ACCOUNT_SEARCH`
 * (the data) and `AUTHORIZATION_SERVICE` (the decision) through `IdentityModule`.
 * `GET /people/:userId/avatar` additionally turns a result's picture reference
 * into a short-lived link through the Files contract (`FILE_ASSETS`), re-asking
 * `people.read` first (ADR 0038). It owns no table and, being a leaf, exports
 * nothing.
 */
@Module({
  imports: [IdentityModule, FilesModule],
  controllers: [PeopleController],
  providers: [SearchPeopleUseCase, SearchTeachersUseCase, GetPersonAvatarLinkUseCase],
})
export class PeopleModule {}
