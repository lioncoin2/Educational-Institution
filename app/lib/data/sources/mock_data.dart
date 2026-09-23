import '../models/certificate.dart';
import '../models/feed.dart';
import '../models/learning.dart';
import '../models/progress.dart';
import '../models/program.dart';
import '../models/student.dart';
import 'profile_data.dart';

/// MOCK CONTENT — invented purely so the prototype can be explored.
///
/// Rules this file follows:
///  * It never contradicts the profile. Where the profile states a number
///    (5 or 10 halaqat per department, 30 ajzaa, 3 mutun), the mock data is
///    generated to match it exactly.
///  * Lesson titles are assembled only from vocabulary the profile itself
///    uses (الحروف، الحركات، مخارج الحروف، القراءة الصحيحة، التلاوة، الإتقان),
///    so no curriculum is fabricated.
///  * Names of people are common given names and refer to nobody real.
///  * Everything produced here is marked [DataOrigin.mock] and the UI shows a
///    "بيانات تجريبية" ribbon wherever it appears.
abstract final class MockData {
  // ── The learner ──────────────────────────────────────────────────────────
  static const StudentProfile student = StudentProfile(
    name: 'مريم',
    targetGroupName: 'الناشئات',
    currentProgramId: 'dep-tajweed-2',
    currentProgramName: 'قسم تجويد متوسط',
    joinedLabel: 'منضمّة منذ 8 أشهر',
    initials: 'م',
  );

  static const List<String> _teachers = [
    'أ. فاطمة',
    'أ. خديجة',
    'أ. عائشة',
    'أ. أم سلمة',
    'أ. ميمونة',
    'أ. سودة',
  ];

  static const List<String> _ordinals = [
    'الأولى',
    'الثانية',
    'الثالثة',
    'الرابعة',
    'الخامسة',
    'السادسة',
    'السابعة',
    'الثامنة',
    'التاسعة',
    'العاشرة',
  ];

  static const List<String> _schedules = [
    'الأحد والثلاثاء · 5:00 مساءً',
    'الاثنين والأربعاء · 6:30 مساءً',
    'السبت والاثنين · 4:00 عصراً',
    'الثلاثاء والخميس · 7:00 مساءً',
    'الأحد والأربعاء · 10:00 صباحاً',
  ];

  /// Lesson titles built only from terms the profile uses.
  static const List<String> _foundationLessons = [
    'الحروف: التعرّف والنطق',
    'الحركات',
    'مخارج الحروف',
    'القراءة الصحيحة',
    'التلاوة والتطبيق',
    'مراجعة وإتقان',
  ];

  static const List<String> _tajweedLessons = [
    'التلاوة: تطبيق عملي',
    'مخارج الحروف وصفاتها',
    'القراءة الصحيحة',
    'التجويد: تطبيق على المقطع',
    'الحفظ والإتقان',
    'مراجعة وإتقان',
  ];

  static const List<String> _passages = [
    'سورة الفاتحة',
    'سورة الإخلاص',
    'سورة الفلق',
    'سورة الناس',
    'سورة الكوثر',
    'سورة العصر',
  ];

  // ── Progress state on the graded ladder ──────────────────────────────────
  /// completed halaqat per department id. Keys match [ProfileData.departments].
  static const Map<String, int> _completedPerDepartment = {
    'dep-literacy': 5,
    'dep-letters': 10,
    'dep-tajweed-1': 10,
    'dep-tajweed-2': 4,
    'dep-tajweed-3': 0,
  };

  static List<PathStep> pathSteps() {
    return ProfileData.departments.map((dep) {
      final done = _completedPerDepartment[dep.id] ?? 0;
      final total = dep.halaqatCount ?? 0;
      final ProgressState state;
      if (dep.id == student.currentProgramId) {
        state = ProgressState.current;
      } else if (done >= total && total > 0) {
        state = ProgressState.completed;
      } else if (dep.order < _currentOrder) {
        state = ProgressState.completed;
      } else if (dep.order == _currentOrder + 1) {
        state = ProgressState.available;
      } else {
        state = ProgressState.locked;
      }
      return PathStep(
        programId: dep.id,
        name: dep.name,
        order: dep.order,
        halaqatCount: total,
        state: state,
        completedHalaqat: done,
      );
    }).toList();
  }

  static int get _currentOrder => ProfileData.departments
      .firstWhere((d) => d.id == student.currentProgramId)
      .order;

  // ── Halaqat ──────────────────────────────────────────────────────────────
  /// Builds exactly as many halaqat as the profile states for [program].
  static List<Halaqa> halaqatFor(Program program) {
    final count = program.halaqatCount ?? program.levelsCount ?? 0;
    if (count == 0) return const [];

    final done = _completedPerDepartment[program.id] ?? 0;
    final isFoundation = program.order <= 2;

    return List.generate(count, (i) {
      final index = i + 1;
      final ProgressState state;
      if (index <= done) {
        state = ProgressState.completed;
      } else if (index == done + 1) {
        state = program.id == student.currentProgramId
            ? ProgressState.current
            : ProgressState.available;
      } else {
        state = ProgressState.locked;
      }

      final titles = isFoundation ? _foundationLessons : _tajweedLessons;
      final lessonCount = titles.length;
      final lessonsDone = switch (state) {
        ProgressState.completed => lessonCount,
        ProgressState.current => 3,
        _ => 0,
      };

      return Halaqa(
        id: '${program.id}-h$index',
        programId: program.id,
        name: 'الحلقة ${_ordinals[i % _ordinals.length]}',
        index: index,
        teacherName: _teachers[(i + program.order) % _teachers.length],
        scheduleLabel: _schedules[i % _schedules.length],
        groupChannelLabel: 'مجموعة الحلقة على واتساب',
        attendedSessions: state == ProgressState.completed
            ? lessonCount
            : (state == ProgressState.current ? 3 : 0),
        totalSessions: lessonCount,
        state: state,
        lessons: List.generate(lessonCount, (j) {
          final LessonState ls;
          if (j < lessonsDone) {
            ls = LessonState.completed;
          } else if (j == lessonsDone && state != ProgressState.locked) {
            ls = LessonState.current;
          } else {
            ls = LessonState.locked;
          }
          return Lesson(
            id: '${program.id}-h$index-l${j + 1}',
            halaqaId: '${program.id}-h$index',
            order: j + 1,
            title: titles[j],
            summary:
                'جلسة تطبيقية ضمن ${program.name}، تركّز على ${titles[j]} '
                'مع متابعة فردية من المعلّمة.',
            durationLabel: '45 دقيقة',
            state: ls,
            objectives: const [
              'إتقان النطق الصحيح',
              'تطبيق عملي أمام المعلّمة',
              'مراجعة ما سبق',
            ],
            passageLabel: _passages[(i + j) % _passages.length],
          );
        }),
      );
    });
  }

  static Halaqa? halaqaById(String id) {
    for (final p in ProfileData.allPrograms) {
      for (final h in halaqatFor(p)) {
        if (h.id == id) return h;
      }
    }
    return null;
  }

  static Lesson? lessonById(String halaqaId, String lessonId) {
    final h = halaqaById(halaqaId);
    if (h == null) return null;
    for (final l in h.lessons) {
      if (l.id == lessonId) return l;
    }
    return null;
  }

  /// The halaqa highlighted on the home screen.
  static Halaqa? currentHalaqa() {
    final program = ProfileData.departments
        .firstWhere((d) => d.id == student.currentProgramId);
    final halaqat = halaqatFor(program);
    for (final h in halaqat) {
      if (h.state == ProgressState.current) return h;
    }
    return halaqat.isEmpty ? null : halaqat.first;
  }

  // ── Progress ─────────────────────────────────────────────────────────────
  static ProgressSummary progress() {
    final completed =
        _completedPerDepartment.values.fold(0, (a, b) => a + b);
    return ProgressSummary(
      studentName: student.name,
      currentProgramName: student.currentProgramName,
      memorisedJuz: const [1, 2, 3, 28, 29, 30],
      totalJuz: 30,
      attendanceRatio: 0.92,
      completedHalaqat: completed,
      totalHalaqat: ProfileData.totalHalaqat,
      mutun: const [
        MatnProgress(
          name: 'تحفة الأطفال',
          ratio: 1.0,
          statusLabel: 'مكتمل',
          started: true,
        ),
        MatnProgress(
          name: 'الجزرية',
          ratio: 0.45,
          statusLabel: 'قيد الحفظ',
          started: true,
        ),
        MatnProgress(
          name: 'الشاطبية',
          ratio: 0.0,
          statusLabel: 'لم يبدأ',
          started: false,
        ),
      ],
      recentActivity: const [
        ActivityEntry(
          title: 'أتممتِ درس «مخارج الحروف وصفاتها»',
          detail: 'الحلقة الرابعة · قسم تجويد متوسط',
          dateLabel: 'اليوم',
          kind: ActivityKind.lesson,
        ),
        ActivityEntry(
          title: 'حضور مسجَّل',
          detail: 'جلسة الأحد · 5:00 مساءً',
          dateLabel: 'أمس',
          kind: ActivityKind.attendance,
        ),
        ActivityEntry(
          title: 'أتممتِ الحلقة الثالثة',
          detail: 'قسم تجويد متوسط',
          dateLabel: 'قبل 4 أيام',
          kind: ActivityKind.halaqa,
        ),
        ActivityEntry(
          title: 'صدرت شهادة إتمام',
          detail: 'قسم تجويد مبتدئ',
          dateLabel: 'قبل شهر',
          kind: ActivityKind.certificate,
        ),
      ],
    );
  }

  // ── Certificates ─────────────────────────────────────────────────────────
  static List<Certificate> certificates() => const [
        Certificate(
          id: 'c1',
          kind: CertificateKind.educational,
          title: 'إتمام قسم تجويد مبتدئ',
          programName: 'قسم تجويد مبتدئ',
          status: CertificateStatus.issued,
          issuedLabel: '12 جمادى الآخرة 1447',
          referenceCode: 'MOCK-EDU-1043',
        ),
        Certificate(
          id: 'c2',
          kind: CertificateKind.educational,
          title: 'إتمام قسم تلقين الحروف',
          programName: 'قسم تلقين الحروف',
          status: CertificateStatus.issued,
          issuedLabel: '3 ربيع الأول 1447',
          referenceCode: 'MOCK-EDU-0876',
        ),
        Certificate(
          id: 'c3',
          kind: CertificateKind.educational,
          title: 'إتمام قسم محو الأمية',
          programName: 'قسم محو الأمية',
          status: CertificateStatus.issued,
          issuedLabel: '20 محرم 1447',
          referenceCode: 'MOCK-EDU-0611',
        ),
        Certificate(
          id: 'c4',
          kind: CertificateKind.appreciation,
          title: 'تقدير على الانتظام في الحضور',
          programName: 'قسم تجويد متوسط',
          status: CertificateStatus.issued,
          issuedLabel: '9 شعبان 1447',
          referenceCode: 'MOCK-APR-0233',
        ),
        Certificate(
          id: 'c5',
          kind: CertificateKind.appreciation,
          title: 'تقدير على إتمام متن تحفة الأطفال',
          programName: 'المتون',
          status: CertificateStatus.issued,
          issuedLabel: '14 رجب 1447',
          referenceCode: 'MOCK-APR-0198',
        ),
        Certificate(
          id: 'c6',
          kind: CertificateKind.ijazah,
          title: 'إجازة في متن الجزرية',
          programName: 'المتون',
          status: CertificateStatus.inProgress,
          issuedLabel: 'قيد الإصدار',
          referenceCode: '—',
          progressNote: 'يتبقّى إتمام حفظ المتن ثم عرضه على المعلّمة',
        ),
        Certificate(
          id: 'c7',
          kind: CertificateKind.educational,
          title: 'إتمام قسم تجويد متوسط',
          programName: 'قسم تجويد متوسط',
          status: CertificateStatus.inProgress,
          issuedLabel: 'قيد الإصدار',
          referenceCode: '—',
          progressNote: 'أتممتِ 4 حلقات من 10',
        ),
      ];

  static Certificate? certificateById(String id) {
    for (final c in certificates()) {
      if (c.id == id) return c;
    }
    return null;
  }

  // ── Announcements (قسم الإعلام) ──────────────────────────────────────────
  static List<Announcement> announcements() => const [
        Announcement(
          id: 'a1',
          category: AnnouncementCategory.informational,
          title: 'فتح التسجيل في قسم التهجي',
          body:
              'يستقبل قسم التهجي مجموعات جديدة هذا الفصل. القسم يبدأ من '
              'الحروف والحركات وصولاً إلى القراءة الصحيحة.',
          dateLabel: 'اليوم',
          channels: ['واتساب', 'تلغرام'],
          isPinned: true,
        ),
        Announcement(
          id: 'a2',
          category: AnnouncementCategory.coverage,
          title: 'تغطية: حفل تكريم خاتمات مدينة الحفاظ',
          body:
              'تغطية مصوّرة لحفل تكريم الطالبات اللاتي أتممن أجزاء من '
              'برنامج مدينة الحفاظ.',
          dateLabel: 'قبل 3 أيام',
          channels: ['وسائل التواصل الاجتماعي'],
        ),
        Announcement(
          id: 'a3',
          category: AnnouncementCategory.design,
          title: 'بطاقة تعليمية: مخارج الحروف',
          body:
              'بطاقة مبسّطة تلخّص مخارج الحروف، ضمن سلسلة البطاقات التعليمية '
              'التي يصدرها قسم الإعلام.',
          dateLabel: 'قبل أسبوع',
          channels: ['واتساب', 'وسائل التواصل الاجتماعي'],
        ),
        Announcement(
          id: 'a4',
          category: AnnouncementCategory.informational,
          title: 'قسم اللغات: مجموعات جديدة',
          body:
              'مجموعات جديدة في الإنجليزي والفرنسي والتركي، تخدم طلبة القرآن '
              'والعلوم الشرعية.',
          dateLabel: 'قبل أسبوعين',
          channels: ['تلغرام'],
        ),
        Announcement(
          id: 'a5',
          category: AnnouncementCategory.coverage,
          title: 'تغطية: ختام الدورة التأسيسية للبراعم',
          body: 'مشاهد من ختام المستوى الأول في قسم البراعم.',
          dateLabel: 'قبل ثلاثة أسابيع',
          channels: ['وسائل التواصل الاجتماعي'],
        ),
      ];
}
