import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { FailureException } from '../../../../platform/http/http-failure';
import type { ResolvePrincipalUseCase } from '../../application/resolve-principal.use-case';
import { PolicyAuthorizationService } from '../../application/authorization.service';
import {
  Authenticated,
  Permissions,
  PublicRoute,
  RequirePermission,
  type Principal,
} from '../../contracts';
import { AccessGuard, type RequestWithPrincipal } from './access.guard';

class Routes {
  @PublicRoute() open(): void {}
  @Authenticated() mine(): void {}
  @RequirePermission(Permissions.users.manage) admin(): void {}
  undeclared(): void {}
}

const PRINCIPAL: Principal = {
  userId: 'u-1',
  roles: [],
  permissions: new Set(['users.read']),
  sessionId: 's-1',
};

function run(
  handler: keyof Routes,
  authorization?: string,
  resolved: Principal | null = PRINCIPAL,
) {
  const request = {
    headers: authorization === undefined ? {} : { authorization },
  } as RequestWithPrincipal;
  const context = {
    // The unbound reference is the point: Nest stores route metadata on this
    // exact function object, and a bound copy would carry none. It is never called.
    // eslint-disable-next-line @typescript-eslint/unbound-method
    getHandler: () => Routes.prototype[handler],
    getClass: () => Routes,
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
  const resolve = jest.fn(async () => resolved);
  const guard = new AccessGuard(
    new Reflector(),
    { execute: resolve } as unknown as ResolvePrincipalUseCase,
    new PolicyAuthorizationService([]),
  );
  return { attempt: () => guard.canActivate(context), request, resolve };
}

async function failureOf(attempt: () => Promise<boolean>): Promise<{ kind: string; code: string }> {
  try {
    await attempt();
  } catch (error) {
    if (error instanceof FailureException) return error.failure;
    throw error;
  }
  throw new Error('expected the guard to refuse');
}

describe('AccessGuard', () => {
  it('fails CLOSED on a route that declares nothing — even for an authenticated caller', async () => {
    const { attempt, resolve } = run('undeclared', 'Bearer token');
    expect(await failureOf(attempt)).toEqual(
      expect.objectContaining({ kind: 'forbidden', code: 'identity.route_undeclared' }),
    );
    expect(resolve).not.toHaveBeenCalled();
  });

  it('lets a public route through without even looking at a token', async () => {
    const { attempt, resolve } = run('open', 'Bearer token');
    await expect(attempt()).resolves.toBe(true);
    expect(resolve).not.toHaveBeenCalled();
  });

  it('requires a live principal on an authenticated route, and attaches it', async () => {
    const { attempt, request } = run('mine', 'Bearer token');
    await expect(attempt()).resolves.toBe(true);
    expect(request.principal).toBe(PRINCIPAL);
  });

  it('answers 401 when the token does not resolve', async () => {
    const { attempt } = run('mine', 'Bearer revoked', null);
    expect((await failureOf(attempt)).code).toBe('identity.authentication_required');
  });

  it('answers 403 when the principal lacks the declared permission', async () => {
    const { attempt } = run('admin', 'Bearer token');
    expect(await failureOf(attempt)).toEqual(
      expect.objectContaining({ kind: 'forbidden', code: 'identity.permission_denied' }),
    );
  });

  it('accepts the bearer scheme case-insensitively, per RFC 7235', async () => {
    const { attempt, resolve } = run('mine', 'bearer abc.def.ghi');
    await attempt();
    expect(resolve).toHaveBeenCalledWith('abc.def.ghi');
  });

  it.each(['Basic abc', 'Bearer', 'Bearer a b', 'Token abc'])(
    'ignores the header %j',
    async (header) => {
      const { attempt, resolve } = run('mine', header);
      expect((await failureOf(attempt)).code).toBe('identity.authentication_required');
      expect(resolve).not.toHaveBeenCalled();
    },
  );
});
