import 'reflect-metadata';

import { NestFactory } from '@nestjs/core';

import { AppModule } from '../app.module';
import {
  STRUCTURE_SEEDER,
  SeedInstitutionStructureUseCase,
} from '../modules/academic/application/seed-structure.use-case';

/**
 * Seeds the institution's academic structure — its sections, programs and the
 * halaqat its profile counts — from the one copy of those facts in the
 * codebase (academic/application/institution-structure.json). A composition
 * root, like main.ts: it boots the application and calls one use case.
 *
 *   npm run db:migrate
 *   npm run build
 *   npm run academic:seed-structure
 *
 * Safe to run again: anything that already exists (by code) is left exactly as
 * it is, including whatever an administrator has renamed or deactivated since.
 * It creates no student, no teacher and no progress.
 */
async function main(): Promise<void> {
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] });
  try {
    const result = await app.get(SeedInstitutionStructureUseCase).execute({
      principal: STRUCTURE_SEEDER,
      meta: { correlationId: 'cli:seed-academic-structure' },
    });
    if (!result.ok) {
      process.stderr.write(`${result.error.code}: ${result.error.message}\n`);
      process.exitCode = 1;
      return;
    }
    const { sections, programs, halaqat } = result.value;
    process.stdout.write(
      [
        `sections: ${sections.created} created, ${sections.existing} already present`,
        `programs: ${programs.created} created, ${programs.existing} already present`,
        `halaqat:  ${halaqat.created} created, ${halaqat.existing} already present`,
      ].join('\n') + '\n',
    );
  } finally {
    await app.close();
  }
}

void main();
