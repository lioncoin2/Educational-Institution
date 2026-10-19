import { MODULE_METADATA } from '@nestjs/common/constants';

import { AcademicModule } from '../academic/academic.module';
import { FilesModule } from '../files/files.module';
import { IdentityModule } from '../identity/identity.module';
import { CommunitiesModule } from './communities.module';
import {
  COMMUNITY_AUTHORIZATION,
  COMMUNITY_CAPABILITY_HOLDERS,
  COMMUNITY_DIRECTORY,
  COMMUNITY_MEMBERSHIP,
} from './contracts';

describe('the Communities module', () => {
  it('imports identity, academic for the Q50 halaqa-existence check, and files for community pictures (ADR 0038) — no chat, no live, no attendance', () => {
    expect(Reflect.getMetadata(MODULE_METADATA.IMPORTS, CommunitiesModule)).toEqual([
      IdentityModule,
      AcademicModule,
      FilesModule,
    ]);
  });

  it('exports its four contract tokens and nothing else', () => {
    expect(Reflect.getMetadata(MODULE_METADATA.EXPORTS, CommunitiesModule)).toEqual([
      COMMUNITY_AUTHORIZATION,
      COMMUNITY_MEMBERSHIP,
      COMMUNITY_CAPABILITY_HOLDERS,
      COMMUNITY_DIRECTORY,
    ]);
  });
});
