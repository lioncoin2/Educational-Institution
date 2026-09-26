import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

import '../core/widgets/layout/adaptive_nav_shell.dart';
import '../features/announcements/announcements_screen.dart';
import '../features/auth/sign_in_screen.dart';
import '../features/certificates/certificate_detail_screen.dart';
import '../features/certificates/certificates_screen.dart';
import '../features/communities/communities_screen.dart';
import '../features/communities/community_invitations_screen.dart';
import '../features/communities/community_members_screen.dart';
import '../features/communities/community_screen.dart';
import '../features/communities/invite_screen.dart';
import '../features/episode/episode_screen.dart';
import '../features/home/home_screen.dart';
import '../features/learning_path/learning_path_screen.dart';
import '../features/learning_path/program_levels_screen.dart';
import '../features/lesson/lesson_screen.dart';
import '../features/messaging/conversation_screen.dart';
import '../features/messaging/conversations_screen.dart';
import '../features/notifications/notification_settings_screen.dart';
import '../features/notifications/notifications_screen.dart';
import '../features/profile/profile_screen.dart';
import '../features/programs/program_detail_screen.dart';
import '../features/programs/programs_screen.dart';
import '../features/progress/progress_screen.dart';
import '../features/splash/splash_screen.dart';
import 'routes.dart';

final _rootNavigatorKey = GlobalKey<NavigatorState>();

/// Five branches, each with its own navigation stack, so switching tabs never
/// loses where you were.
GoRouter buildRouter() {
  return GoRouter(
    navigatorKey: _rootNavigatorKey,
    initialLocation: Routes.splash,
    routes: [
      GoRoute(
        path: Routes.splash,
        name: 'splash',
        builder: (context, state) => const SplashScreen(),
      ),

      // Full-screen routes that sit above the tab bar.
      GoRoute(
        path: Routes.notifications,
        name: 'notifications',
        parentNavigatorKey: _rootNavigatorKey,
        builder: (context, state) => const NotificationsScreen(),
        routes: [
          GoRoute(
            path: 'settings',
            name: 'notification-settings',
            parentNavigatorKey: _rootNavigatorKey,
            builder: (context, state) => const NotificationSettingsScreen(),
          ),
        ],
      ),
      GoRoute(
        path: Routes.announcements,
        name: 'announcements',
        parentNavigatorKey: _rootNavigatorKey,
        builder: (context, state) => const AnnouncementsScreen(),
      ),
      GoRoute(
        path: Routes.progress,
        name: 'progress',
        parentNavigatorKey: _rootNavigatorKey,
        builder: (context, state) => const ProgressScreen(),
      ),
      GoRoute(
        path: Routes.messages,
        name: 'messages',
        parentNavigatorKey: _rootNavigatorKey,
        builder: (context, state) => const ConversationsScreen(),
        routes: [
          GoRoute(
            path: ':conversationId',
            name: 'conversation',
            parentNavigatorKey: _rootNavigatorKey,
            builder: (context, state) => ConversationScreen(
              conversationId: state.pathParameters['conversationId']!,
            ),
          ),
        ],
      ),
      GoRoute(
        path: Routes.communities,
        name: 'communities',
        parentNavigatorKey: _rootNavigatorKey,
        builder: (context, state) => const CommunitiesScreen(),
        routes: [
          GoRoute(
            path: ':communityId',
            name: 'community',
            parentNavigatorKey: _rootNavigatorKey,
            builder: (context, state) => CommunityScreen(
              communityId: state.pathParameters['communityId']!,
            ),
            routes: [
              GoRoute(
                path: 'members',
                name: 'community-members',
                parentNavigatorKey: _rootNavigatorKey,
                builder: (context, state) => CommunityMembersScreen(
                  communityId: state.pathParameters['communityId']!,
                ),
              ),
              GoRoute(
                path: 'invitations',
                name: 'community-invitations',
                parentNavigatorKey: _rootNavigatorKey,
                builder: (context, state) => CommunityInvitationsScreen(
                  communityId: state.pathParameters['communityId']!,
                ),
              ),
            ],
          ),
        ],
      ),
      // An invitation link. It carries nothing the route reads: the token
      // was taken from the link's fragment before the router existed.
      GoRoute(
        path: Routes.invite,
        name: 'invite',
        parentNavigatorKey: _rootNavigatorKey,
        builder: (context, state) => const InviteScreen(),
      ),
      GoRoute(
        path: Routes.signIn,
        name: 'sign-in',
        parentNavigatorKey: _rootNavigatorKey,
        builder: (context, state) => const SignInScreen(),
      ),

      StatefulShellRoute.indexedStack(
        builder: (context, state, shell) => AdaptiveNavShell(shell: shell),
        branches: [
          // 0 — الرئيسية
          StatefulShellBranch(
            routes: [
              GoRoute(
                path: Routes.home,
                name: 'home',
                builder: (context, state) => const HomeScreen(),
              ),
            ],
          ),

          // 1 — البرامج → التفاصيل → المستويات → الحلقة → الدرس
          StatefulShellBranch(
            routes: [
              GoRoute(
                path: Routes.programs,
                name: 'programs',
                builder: (context, state) => const ProgramsScreen(),
                routes: [
                  GoRoute(
                    path: ':programId',
                    name: 'program',
                    builder: (context, state) => ProgramDetailScreen(
                      programId: state.pathParameters['programId']!,
                    ),
                    routes: [
                      GoRoute(
                        path: 'levels',
                        name: 'levels',
                        builder: (context, state) => ProgramLevelsScreen(
                          programId: state.pathParameters['programId']!,
                        ),
                        routes: [
                          GoRoute(
                            path: ':halaqaId',
                            name: 'episode',
                            builder: (context, state) => EpisodeScreen(
                              programId: state.pathParameters['programId']!,
                              halaqaId: state.pathParameters['halaqaId']!,
                            ),
                            routes: [
                              GoRoute(
                                path: 'lessons/:lessonId',
                                name: 'lesson',
                                builder: (context, state) => LessonScreen(
                                  programId: state.pathParameters['programId']!,
                                  halaqaId: state.pathParameters['halaqaId']!,
                                  lessonId: state.pathParameters['lessonId']!,
                                ),
                              ),
                            ],
                          ),
                        ],
                      ),
                    ],
                  ),
                ],
              ),
            ],
          ),

          // 2 — مساري
          StatefulShellBranch(
            routes: [
              GoRoute(
                path: Routes.path,
                name: 'path',
                builder: (context, state) => const LearningPathScreen(),
              ),
            ],
          ),

          // 3 — الشهادات
          StatefulShellBranch(
            routes: [
              GoRoute(
                path: Routes.certificates,
                name: 'certificates',
                builder: (context, state) => const CertificatesScreen(),
                routes: [
                  GoRoute(
                    path: ':certificateId',
                    name: 'certificate',
                    builder: (context, state) => CertificateDetailScreen(
                      certificateId: state.pathParameters['certificateId']!,
                    ),
                  ),
                ],
              ),
            ],
          ),

          // 4 — حسابي
          StatefulShellBranch(
            routes: [
              GoRoute(
                path: Routes.profile,
                name: 'profile',
                builder: (context, state) => const ProfileScreen(),
              ),
            ],
          ),
        ],
      ),
    ],
    errorBuilder: (context, state) => _RouteNotFound(location: state.uri.path),
  );
}

class _RouteNotFound extends StatelessWidget {
  const _RouteNotFound({required this.location});

  final String location;

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('صفحة غير موجودة')),
      body: Center(
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              const Icon(Icons.explore_off_outlined, size: 48),
              const SizedBox(height: 16),
              Text(
                'لا توجد شاشة على المسار:\n$location',
                textAlign: TextAlign.center,
                style: Theme.of(context).textTheme.bodyMedium,
              ),
              const SizedBox(height: 24),
              FilledButton(
                onPressed: () => context.go(Routes.home),
                child: const Text('العودة إلى الرئيسية'),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
