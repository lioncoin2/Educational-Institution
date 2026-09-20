import 'data_origin.dart';

/// The three service lines of قسم الإعلام والإعلان والتصاميم (page 11).
enum AnnouncementCategory {
  informational('محتوى تعريفي'),
  design('بطاقات ومنشورات'),
  coverage('تغطية أنشطة');

  const AnnouncementCategory(this.label);
  final String label;
}

/// A post from the media section. Categories and publishing channels are real
/// (page 11); the posts themselves are mock.
class Announcement implements Sourced {
  const Announcement({
    required this.id,
    required this.category,
    required this.title,
    required this.body,
    required this.dateLabel,
    required this.channels,
    this.isPinned = false,
  });

  final String id;
  final AnnouncementCategory category;
  final String title;
  final String body;
  final String dateLabel;

  /// From page 11: واتساب، تلغرام، وسائل التواصل الاجتماعي.
  final List<String> channels;

  final bool isPinned;

  @override
  DataOrigin get origin => DataOrigin.mock;
}

enum NotificationKind { halaqa, lesson, certificate, announcement }

class AppNotification implements Sourced {
  const AppNotification({
    required this.id,
    required this.kind,
    required this.title,
    required this.body,
    required this.timeLabel,
    required this.isRead,
  });

  final String id;
  final NotificationKind kind;
  final String title;
  final String body;
  final String timeLabel;
  final bool isRead;

  AppNotification copyWith({bool? isRead}) => AppNotification(
        id: id,
        kind: kind,
        title: title,
        body: body,
        timeLabel: timeLabel,
        isRead: isRead ?? this.isRead,
      );

  @override
  DataOrigin get origin => DataOrigin.mock;
}
