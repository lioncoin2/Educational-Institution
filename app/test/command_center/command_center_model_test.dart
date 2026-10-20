import 'package:flutter_test/flutter_test.dart';
import 'package:quran_institution_app/data/models/command_center.dart';
import 'package:quran_institution_app/data/models/data_origin.dart';

void main() {
  group('CommandCenter.fromJson', () {
    test('parses widgets, categories, titles and metrics', () {
      final center = CommandCenter.fromJson({
        'widgets': [
          {
            'id': 'academic.structure',
            'category': 'today',
            'title': 'الهيكل الأكاديمي',
            'payload': {
              'metrics': [
                {'key': 'halaqat_active', 'label': 'الحلقات المُفعّلة', 'value': 45},
              ],
            },
          },
        ],
      });

      expect(center.widgets, hasLength(1));
      final widget = center.widgets.single;
      expect(widget.id, 'academic.structure');
      expect(widget.category, 'today');
      expect(widget.title, 'الهيكل الأكاديمي');
      expect(widget.metrics.single.key, 'halaqat_active');
      expect(widget.metrics.single.value, 45);
      expect(center.origin, DataOrigin.records);
      expect(center.isEmpty, isFalse);
    });

    test('an empty widget set is a valid answer, not an error', () {
      final center = CommandCenter.fromJson({'widgets': <Object?>[]});
      expect(center.isEmpty, isTrue);
    });

    test('reads defensively: unknown payload shape yields no metrics, no throw', () {
      final center = CommandCenter.fromJson({
        'widgets': [
          {'id': 'x', 'category': 'today', 'title': 'بلا بيانات', 'payload': <String, Object?>{}},
          {'id': 'y', 'category': 'today', 'title': 'شكل غريب', 'payload': 'not-a-map'},
        ],
      });
      expect(center.widgets, hasLength(2));
      expect(center.widgets[0].metrics, isEmpty);
      expect(center.widgets[1].metrics, isEmpty);
    });

    test('a non-numeric metric value becomes 0 rather than crashing', () {
      final center = CommandCenter.fromJson({
        'widgets': [
          {
            'id': 'x',
            'category': 'today',
            'title': 't',
            'payload': {
              'metrics': [
                {'key': 'k', 'label': 'l', 'value': 'oops'},
              ],
            },
          },
        ],
      });
      expect(center.widgets.single.metrics.single.value, 0);
    });

    test('carries the mock origin when told', () {
      final center = CommandCenter.fromJson({'widgets': <Object?>[]}, origin: DataOrigin.mock);
      expect(center.origin, DataOrigin.mock);
    });
  });

  group('ReportingException', () {
    test('classifies the server codes', () {
      expect(const ReportingException('identity.permission_denied', 'x').isForbidden, isTrue);
      expect(const ReportingException('unavailable', 'x').isUnavailable, isTrue);
      expect(
        const ReportingException('identity.authentication_required', 'x').needsSignIn,
        isTrue,
      );
    });
  });
}
