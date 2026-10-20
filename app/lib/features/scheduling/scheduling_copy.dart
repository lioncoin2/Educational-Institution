import '../../data/models/scheduling.dart';

/// Arabic copy for the scheduling feature (dated lessons, ADR 0042).
abstract final class SchedulingCopy {
  static const String title = 'جدولة الدروس';
  static const String subtitle = 'دروس مفردة مؤرخة';

  static const String empty = 'لا توجد دروس مجدولة';
  static const String emptyMessage = 'أضف درسًا مؤرخًا ليظهر هنا.';

  static const String addLesson = 'جدولة درس';
  static const String editLesson = 'تعديل الدرس';
  static const String refresh = 'تحديث';
  static const String loadMore = 'عرض المزيد';

  static const String halaqa = 'الحلقة';
  static const String pickHalaqa = 'اختر الحلقة';
  static const String program = 'البرنامج';
  static const String pickProgram = 'اختر البرنامج';
  static const String lessonTitle = 'عنوان الدرس (اختياري)';
  static const String date = 'التاريخ';
  static const String pickDate = 'اختر التاريخ';
  static const String time = 'الوقت';
  static const String pickTime = 'اختر الوقت';
  static const String timezone = 'المنطقة الزمنية';
  static const String timezoneHint =
      'تُحفظ المنطقة الزمنية مع الدرس، فلا يتغير موعده لاحقًا إن تغيّرت منطقة المؤسسة.';

  static const String save = 'حفظ';
  static const String create = 'جدولة';

  static const String created = 'تم جدولة الدرس';
  static const String updated = 'تم تحديث الدرس';
  static const String cancelledToast = 'تم إلغاء الدرس';

  static const String cancelLesson = 'إلغاء الدرس';
  static const String keep = 'تراجع';
  static const String confirmCancel = 'تأكيد الإلغاء';
  static String cancelQuestion(String when) => 'هل تريد إلغاء الدرس المجدول في $when؟';

  static const String statusScheduled = 'مجدول';
  static const String statusCancelled = 'ملغى';

  static String status(LessonStatus value) => switch (value) {
        LessonStatus.scheduled => statusScheduled,
        LessonStatus.cancelled => statusCancelled,
        LessonStatus.unknown => '—',
      };

  /// Turns a backend error code into an Arabic sentence.
  static String changeFailed(String code) => switch (code) {
        'operations.halaqa_not_found' => 'الحلقة غير موجودة.',
        'operations.timezone_invalid' => 'المنطقة الزمنية غير صالحة.',
        'operations.timezone_required' => 'يجب تحديد المنطقة الزمنية.',
        'operations.local_time_invalid' => 'التاريخ أو الوقت غير صحيح.',
        'operations.local_time_nonexistent' =>
          'هذا الوقت لا يقع في هذه المنطقة الزمنية بسبب التغيير الصيفي. اختر وقتًا آخر.',
        'operations.lesson_in_the_past' => 'لا يمكن جدولة درس في وقت ماضٍ.',
        'operations.lesson_not_modifiable' => 'لا يمكن تعديل درس ملغى.',
        'operations.lesson_not_found' => 'الدرس غير موجود.',
        'operations.title_too_long' => 'العنوان طويل جدًا.',
        'identity.permission_denied' => 'هذا الإجراء غير متاح لك.',
        'identity.authentication_required' => 'انتهت الجلسة. سجّل الدخول من جديد.',
        'network.unreachable' => 'تعذّر الوصول إلى الخادم. تحقق من الاتصال.',
        _ => 'تعذّر إتمام العملية. حاول مرة أخرى.',
      };
}
