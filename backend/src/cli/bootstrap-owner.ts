import 'reflect-metadata';

import { createInterface } from 'node:readline';
import { parseArgs } from 'node:util';

import { NestFactory } from '@nestjs/core';

import { AppModule } from '../app.module';
import { BootstrapOwnerUseCase } from '../modules/identity/application/bootstrap-owner.use-case';

/**
 * Creates the first OWNER account. A composition root, like main.ts: it boots
 * the application and calls one use case.
 *
 *   npm run build
 *   read -rs OWNER_PW && printf '%s\n' "$OWNER_PW" | \
 *     node dist/cli/bootstrap-owner.js --email owner@institution.org --name "Full Name"
 *
 * The password is read from standard input — never an argument or an
 * environment variable, either of which would leave it in shell history or in
 * `ps` output. The use case refuses to run once an active owner exists.
 */
async function main(): Promise<void> {
  const { values } = parseArgs({
    options: { email: { type: 'string' }, name: { type: 'string' } },
    strict: true,
  });
  if (values.email === undefined || values.name === undefined) {
    process.stderr.write(
      'usage: bootstrap-owner --email <address> --name <display name>  (password on stdin)\n',
    );
    process.exitCode = 2;
    return;
  }

  const password = await firstLine(process.stdin);
  if (password === null || password.length === 0) {
    process.stderr.write('No password received on standard input.\n');
    process.exitCode = 2;
    return;
  }

  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] });
  try {
    const result = await app.get(BootstrapOwnerUseCase).execute({
      displayName: values.name,
      identifierKind: 'email',
      identifier: values.email,
      password,
      meta: { correlationId: 'cli:bootstrap-owner' },
    });
    if (!result.ok) {
      process.stderr.write(`${result.error.code}: ${result.error.message}\n`);
      process.exitCode = 1;
      return;
    }
    process.stdout.write(`Owner account created: ${result.value.id}\n`);
  } finally {
    await app.close();
  }
}

function firstLine(input: NodeJS.ReadableStream): Promise<string | null> {
  return new Promise((resolve) => {
    const lines = createInterface({ input, terminal: false });
    let settled = false;
    lines.once('line', (line) => {
      settled = true;
      lines.close();
      resolve(line);
    });
    lines.once('close', () => {
      if (!settled) resolve(null);
    });
  });
}

void main();
