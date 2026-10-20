import '../../../app/app_config.dart';
import '../../models/command_center.dart';
import '../../models/data_origin.dart';
import '../repositories.dart';

/// In-memory stand-in for `/reporting`, for the demo build and widget tests.
///
/// It keeps the server's shape — the same widget ids, categories and metric
/// payloads — with invented, [DataOrigin.mock]-flagged figures. The demo shows
/// the command center's layout and states; the real counts come only from the
/// backend. Deterministic, so a test reads the same numbers each run.
class MockReportingRepository implements ReportingRepository {
  const MockReportingRepository({this.latency = AppConfig.fakeLatency});

  final Duration latency;

  @override
  Future<CommandCenter> commandCenter() async {
    await Future<void>.delayed(latency);
    return const CommandCenter(
      origin: DataOrigin.mock,
      actions: [
        CommandAction(id: 'publish.communities', title: 'النشر إلى عدة مجتمعات'),
        CommandAction(id: 'communities.create', title: 'إنشاء مجتمع'),
        CommandAction(id: 'academic.structure', title: 'إدارة الهيكل الأكاديمي'),
        CommandAction(id: 'accounts.admin', title: 'إدارة الحسابات'),
      ],
      widgets: [
        CommandWidget(
          id: 'accounts.summary',
          category: 'today',
          title: 'الحسابات',
          metrics: [
            CommandMetric(key: 'total', label: 'إجمالي الحسابات', value: 128),
            CommandMetric(key: 'active', label: 'نشطة', value: 119),
            CommandMetric(key: 'pending', label: 'قيد التفعيل', value: 6),
            CommandMetric(key: 'suspended', label: 'موقوفة', value: 2),
            CommandMetric(key: 'disabled', label: 'معطّلة', value: 1),
          ],
        ),
        CommandWidget(
          id: 'academic.structure',
          category: 'today',
          title: 'الهيكل الأكاديمي',
          metrics: [
            CommandMetric(key: 'sections_active', label: 'الأقسام المُفعّلة', value: 5),
            CommandMetric(key: 'programs_active', label: 'البرامج المُفعّلة', value: 9),
            CommandMetric(key: 'halaqat_active', label: 'الحلقات المُفعّلة', value: 45),
          ],
        ),
        CommandWidget(
          id: 'communities.summary',
          category: 'today',
          title: 'المجتمعات',
          metrics: [
            CommandMetric(key: 'total', label: 'إجمالي المجتمعات', value: 3),
            CommandMetric(key: 'accepting', label: 'تقبل أعضاءً جُددًا', value: 2),
          ],
        ),
      ],
    );
  }
}
