import { BootstrapOwnerUseCase } from '../../src/modules/identity/application/bootstrap-owner.use-case';
import { CommunitiesRealtimeRelay } from '../../src/modules/realtime/application/communities-relay';
import { MessagingRealtimeRelay } from '../../src/modules/realtime/application/messaging-relay';
import { RealtimeSessions } from '../../src/modules/realtime/application/realtime-sessions';
import { WebSocketTransport } from '../../src/modules/realtime/infrastructure/websocket-transport';
import { startApi, type RunningApi } from './api-client';
import { TestSocket, type WireMessage } from './realtime-client';

export interface Account {
  readonly id: string;
  readonly email: string;
  readonly password: string;
  readonly token: string;
  readonly refreshToken: string;
}

/**
 * The real application — AppModule, configureApp, the real HTTP server with
 * the realtime endpoint on it — plus the steps every realtime API suite
 * needs: a bootstrapped owner, accounts provisioned through the admin API,
 * and messaging and communities over HTTP.
 */
export async function startRealtimeApi(env: Record<string, string> = {}) {
  const api: RunningApi = await startApi(env);
  const wsUrl = `${api.base.replace(/^http/, 'ws')}/realtime`;

  const bootstrapped = await api.app.get(BootstrapOwnerUseCase).execute({
    displayName: 'Owner',
    identifierKind: 'email',
    identifier: 'owner@institution.test',
    password: 'owner passphrase one',
    meta: {},
  });
  if (!bootstrapped.ok) throw new Error(bootstrapped.error.code);

  async function signIn(email: string, password: string) {
    const login = await api.call('POST', '/auth/login', { body: { identifier: email, password } });
    if (login.status !== 200) throw new Error(`login failed for ${email}: ${login.status}`);
    return {
      token: login.body.accessToken as string,
      refreshToken: login.body.refreshToken as string,
    };
  }

  const ownerTokens = await signIn('owner@institution.test', 'owner passphrase one');
  const owner: Account = {
    id: bootstrapped.value.id,
    email: 'owner@institution.test',
    password: 'owner passphrase one',
    ...ownerTokens,
  };

  const r = {
    api,
    wsUrl,
    owner,
    transport: api.app.get(WebSocketTransport),
    sessions: api.app.get(RealtimeSessions),
    relay: api.app.get(MessagingRealtimeRelay),
    communitiesRelay: api.app.get(CommunitiesRealtimeRelay),

    async provision(name: string, role: string, displayName = name): Promise<Account> {
      const email = `${name}@institution.test`;
      const password = `${name} passphrase long enough`;
      const created = await api.call('POST', '/admin/users', {
        token: owner.token,
        body: { displayName, identifier: email, initialPassword: password },
      });
      const id = created.body.id as string;
      await api.call('POST', `/admin/users/${id}/roles`, { token: owner.token, body: { role } });
      await api.call('POST', `/admin/users/${id}/status`, {
        token: owner.token,
        body: { status: 'ACTIVE' },
      });
      return { id, email, password, ...(await signIn(email, password)) };
    },

    /** A second signed-in session for the same account — another device. */
    async anotherDevice(account: Account): Promise<Account> {
      return { ...account, ...(await signIn(account.email, account.password)) };
    },

    connect(account: Account): Promise<TestSocket> {
      return TestSocket.signedIn(wsUrl, account.token);
    },

    async group(owner: Account, members: readonly Account[], title = 'حلقة الفجر') {
      const response = await api.call('POST', '/messaging/conversations/groups', {
        token: owner.token,
        body: { title, memberIds: members.map((member) => member.id) },
      });
      if (response.status !== 201) throw new Error(`group: ${response.status} ${response.raw}`);
      return response.body.id as string;
    },

    async send(from: Account, conversationId: string, body: string, clientMessageId?: string) {
      const response = await api.call(
        'POST',
        `/messaging/conversations/${conversationId}/messages/text`,
        {
          token: from.token,
          body: {
            clientMessageId: clientMessageId ?? `key-${Math.random().toString(36).slice(2)}`,
            body,
          },
        },
      );
      if (response.status !== 201) throw new Error(`send: ${response.status} ${response.raw}`);
      return response.body as unknown as WireMessage;
    },

    async messagesAfter(account: Account, conversationId: string, after: number) {
      const response = await api.call(
        'GET',
        `/messaging/conversations/${conversationId}/messages?after=${after}&limit=2`,
        { token: account.token },
      );
      if (response.status !== 200) throw new Error(`page: ${response.status} ${response.raw}`);
      return {
        items: response.body.items as WireMessage[],
        hasNewer: response.body.hasNewer as boolean,
      };
    },

    async timeline(account: Account, conversationId: string): Promise<WireMessage[]> {
      const response = await api.call(
        'GET',
        `/messaging/conversations/${conversationId}/messages?limit=100`,
        { token: account.token },
      );
      return response.body.items as WireMessage[];
    },

    async removeMember(owner: Account, conversationId: string, userId: string): Promise<void> {
      const response = await api.call(
        'DELETE',
        `/messaging/conversations/${conversationId}/participants/${userId}`,
        { token: owner.token },
      );
      if (response.status !== 204) throw new Error(`remove: ${response.status} ${response.raw}`);
    },

    /** A community created over HTTP by `owner`, who must hold communities.create. */
    async createCommunity(owner: Account, title = 'حلقة التجويد'): Promise<string> {
      const response = await api.call('POST', '/communities', {
        token: owner.token,
        body: { title },
      });
      if (response.status !== 201) throw new Error(`community: ${response.status} ${response.raw}`);
      return response.body.id as string;
    },

    async addToCommunity(by: Account, communityId: string, members: readonly Account[]) {
      const response = await api.call('POST', `/communities/${communityId}/members`, {
        token: by.token,
        body: { userIds: members.map((member) => member.id) },
      });
      if (response.status !== 201 && response.status !== 200) {
        throw new Error(`add members: ${response.status} ${response.raw}`);
      }
    },

    async removeFromCommunity(by: Account, communityId: string, userId: string): Promise<void> {
      const response = await api.call('DELETE', `/communities/${communityId}/members/${userId}`, {
        token: by.token,
      });
      if (response.status !== 204) throw new Error(`remove: ${response.status} ${response.raw}`);
    },

    /** Locks or unlocks; the community as the response returns it. */
    async setCommunityLocked(by: Account, communityId: string, locked: boolean) {
      const response = await api.call(
        'POST',
        `/communities/${communityId}/${locked ? 'lock' : 'unlock'}`,
        { token: by.token },
      );
      if (response.status !== 200) throw new Error(`lock: ${response.status} ${response.raw}`);
      return response.body;
    },

    async grantCapabilities(
      owner: Account,
      communityId: string,
      userId: string,
      capabilities: readonly string[],
    ): Promise<void> {
      const response = await api.call('POST', `/communities/${communityId}/grants`, {
        token: owner.token,
        body: { userId, capabilities },
      });
      if (response.status !== 201) throw new Error(`grant: ${response.status} ${response.raw}`);
    },

    async close(): Promise<void> {
      await api.close();
    },
  };
  return r;
}

export type RealtimeApi = Awaited<ReturnType<typeof startRealtimeApi>>;
