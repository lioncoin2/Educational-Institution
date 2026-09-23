import { MODULE_METADATA } from '@nestjs/common/constants';

import { IdentityModule } from '../identity/identity.module';
import { CommunitiesModule } from './communities.module';
import { COMMUNITY_AUTHORIZATION, COMMUNITY_DIRECTORY, COMMUNITY_MEMBERSHIP } from './contracts';

describe('the Communities module', () => {
  it('imports identity and nothing else — no chat, no live, no attendance', () => {
    expect(Reflect.getMetadata(MODULE_METADATA.IMPORTS, CommunitiesModule)).toEqual([
      IdentityModule,
    ]);
  });

  it('exports its three contract tokens and nothing else', () => {
    expect(Reflect.getMetadata(MODULE_METADATA.EXPORTS, CommunitiesModule)).toEqual([
      COMMUNITY_AUTHORIZATION,
      COMMUNITY_MEMBERSHIP,
      COMMUNITY_DIRECTORY,
    ]);
  });
});
