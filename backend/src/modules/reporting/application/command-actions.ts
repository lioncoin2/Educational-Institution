import { Permissions } from '../../identity/contracts/permissions';
import type { CommandActionDescriptor } from '../contracts';

/**
 * The command-centre's quick actions — each a shortcut to a real, already-built
 * operation, gated by the existing permission that operation requires. The
 * command centre shows a viewer only the actions whose permission they hold;
 * the operation itself re-authorizes server-side when invoked (the list is a
 * convenience, never the boundary). No action here grants anything or names an
 * unbuilt feature.
 *
 *   publish.communities  mass-publish a file/image/voice to several communities
 *                        (POST /messaging/communities/publish)       — messaging.send
 *   communities.create   create a community                          — communities.create
 *   academic.structure   manage sections / programs / halaqat        — academic.manage
 *   accounts.admin       provision and administer accounts           — users.manage
 */
export const COMMAND_ACTION_CATALOG: readonly CommandActionDescriptor[] = Object.freeze([
  {
    id: 'publish.communities',
    title: 'النشر إلى عدة مجتمعات',
    requiredPermission: Permissions.messaging.send,
  },
  {
    id: 'communities.create',
    title: 'إنشاء مجتمع',
    requiredPermission: Permissions.communities.create,
  },
  {
    id: 'academic.structure',
    title: 'إدارة الهيكل الأكاديمي',
    requiredPermission: Permissions.academic.manage,
  },
  {
    id: 'accounts.admin',
    title: 'إدارة الحسابات',
    requiredPermission: Permissions.users.manage,
  },
]);
