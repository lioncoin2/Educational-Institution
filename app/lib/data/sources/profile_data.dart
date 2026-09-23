import '../models/institution.dart';
import '../models/program.dart';

/// REAL CONTENT — transcribed from `docs/institution-profile.pdf`.
///
/// Nothing in this file is invented. Every string is either verbatim from the
/// profile or a direct transcription of it, and each entry records the page it
/// came from. See `docs/pdf-content-extract.md` for the page-by-page source.
///
/// If you need placeholder content, put it in `mock_data.dart` instead.
abstract final class ProfileData {
  // ── Page 1 + 3 ───────────────────────────────────────────────────────────
  static const Institution institution = Institution(
    name: 'المؤسسة العالمية لتعليم القرآن الكريم وعلومه الشرعية السبعة',
    shortName: 'المؤسسة العالمية لتعليم القرآن الكريم',
    tagline: 'نبذة شاملة عن المؤسسة وخدماتها ورؤيتها',
    about:
        'مؤسسة تعليمية عالمية عن بعد، مجانية بالكامل. ذات خبرة وباع في تعليم '
        'القرآن الكريم والعلوم الشرعية السبعة. تعمل على تقديم تعليم أصيل، '
        'ومنهج متدرج، وتأهيل متخصص، يسهم في بناء أجيال متقنة لكتاب الله، '
        'راسخة في العلم، واعية برسالتها في التعليم والدعوة والتربية.',
    mission: 'التعليم والدعوة والتربية',
    targetGroups: targetGroups,
    fields: studyFields,
    futureHorizons: futureHorizons,
    certificateKinds: certificateKinds,
  );

  // ── Page 4 — الفئات المستهدفة ────────────────────────────────────────────
  static const List<TargetGroup> targetGroups = [
    TargetGroup(
      id: 'kids',
      name: 'البراعم',
      detail: 'أطفال من عمر 3 سنوات إلى 12 سنة',
    ),
    TargetGroup(id: 'youth', name: 'الناشئات'),
    TargetGroup(id: 'elders', name: 'كبار السن'),
    TargetGroup(id: 'non-arabic', name: 'غير الناطقين باللغة العربية'),
    TargetGroup(id: 'literacy', name: 'محو الأمية'),
  ];

  /// Page 4 subtitle.
  static const String targetGroupsSubtitle = 'كل الفئات العمرية';

  // ── Page 5 — مجالات التعليم والتخصص ─────────────────────────────────────
  static const List<StudyField> studyFields = [
    StudyField(id: 'f1', name: 'القرآن حفظاً وإتقاناً'),
    StudyField(id: 'f2', name: 'العلوم الشرعية'),
    StudyField(id: 'f3', name: 'التجويد والقراءات'),
    StudyField(id: 'f4', name: 'علوم اللغة والنحو'),
    StudyField(id: 'f5', name: 'قسم المتون العلمية'),
    StudyField(id: 'f6', name: 'قسم التعليم الدولي'),
  ];

  // ── Page 6 — أقسام المؤسسة (the graded ladder) ──────────────────────────
  static const String departmentsIntro =
      'تقدم المؤسسة برامج تعليمية متدرجة للمبتدئين والمتوسطات والمتقدمات، '
      'مع مسارات متخصصة في الحفظ والقراءات والمتون والنحو وعلوم الحديث.';

  static const List<Program> departments = [
    Program(
      id: 'dep-literacy',
      name: 'قسم محو الأمية',
      kind: ProgramKind.department,
      sourcePage: 6,
      order: 1,
      halaqatCount: 5,
      iconName: 'literacy',
    ),
    Program(
      id: 'dep-letters',
      name: 'قسم تلقين الحروف',
      kind: ProgramKind.department,
      sourcePage: 6,
      order: 2,
      halaqatCount: 10,
      iconName: 'letters',
    ),
    Program(
      id: 'dep-tajweed-1',
      name: 'قسم تجويد مبتدئ',
      kind: ProgramKind.department,
      sourcePage: 6,
      order: 3,
      halaqatCount: 10,
      iconName: 'tajweed',
    ),
    Program(
      id: 'dep-tajweed-2',
      name: 'قسم تجويد متوسط',
      kind: ProgramKind.department,
      sourcePage: 6,
      order: 4,
      halaqatCount: 10,
      iconName: 'tajweed',
    ),
    Program(
      id: 'dep-tajweed-3',
      name: 'قسم تجويد متقدم',
      kind: ProgramKind.department,
      sourcePage: 6,
      order: 5,
      halaqatCount: 10,
      iconName: 'tajweed',
    ),
  ];

  /// 45 — the sum of the halaqat counts stated on page 6.
  static int get totalHalaqat =>
      departments.fold(0, (sum, d) => sum + (d.halaqatCount ?? 0));

  // ── Pages 7, 8, 9 — الأقسام الخاصة ──────────────────────────────────────
  static const List<Program> specialSections = [
    Program(
      id: 'sec-spelling',
      name: 'قسم التهجي',
      kind: ProgramKind.special,
      sourcePage: 7,
      description:
          'أقوى قسم في المؤسسة، يختص في تعليم أساسيات قراءة القرآن الكريم، '
          'بدءاً من الحروف والحركات وصولاً إلى القراءة الصحيحة، مع العناية '
          'بالنطق ومخارج الحروف.',
      capacityNote: 'استيعاب 40 مجموعة',
      items: [
        'الحروف',
        'الحركات',
        'القراءة الصحيحة',
        'النطق ومخارج الحروف',
      ],
      iconName: 'spelling',
    ),
    Program(
      id: 'sec-kids',
      name: 'قسم البراعم',
      kind: ProgramKind.special,
      sourcePage: 8,
      description:
          'برامج تعليمية مخصصة للأطفال في المراحل المبكرة، تُعنى بتأسيسهم في '
          'قراءة القرآن الكريم والتهجي والحفظ والتلاوة، بأساليب تربوية مبسطة '
          'تناسب أعمارهم وقدراتهم، مع غرس محبة القرآن والسنة والقيم في نفوسهم.',
      levelsCount: 3,
      items: ['قراءة القرآن الكريم', 'التهجي', 'الحفظ', 'التلاوة'],
      iconName: 'kids',
    ),
    Program(
      id: 'sec-languages',
      name: 'قسم اللغات',
      kind: ProgramKind.special,
      sourcePage: 9,
      description:
          'تُعنى بتعليم وتعريب اللغات وتنمية مهارات التواصل اللغوي، يخدم طلبة '
          'القرآن والعلوم الشرعية، مع برامج مناسبة لمختلف المستويات والفئات.',
      items: ['الإنجليزي', 'الفرنسي', 'الألماني', 'الإسباني', 'التركي'],
      iconName: 'languages',
    ),
  ];

  // ── Page 10 — البرامج المرافقة ──────────────────────────────────────────
  /// The page's heading — the name of the group the four programs form.
  static const String companionProgramsHeading = 'البرامج المرافقة';

  static const List<Program> companionPrograms = [
    Program(
      id: 'prog-hifz-city',
      name: 'مدينة الحفاظ',
      kind: ProgramKind.companion,
      sourcePage: 10,
      badge: '30 جزء',
      iconName: 'hifz',
    ),
    Program(
      id: 'prog-nahw',
      name: 'علوم النحو',
      kind: ProgramKind.companion,
      sourcePage: 10,
      badge: '5 مستويات',
      levelsCount: 5,
      iconName: 'nahw',
    ),
    Program(
      id: 'prog-maqari',
      name: 'المقارئ',
      kind: ProgramKind.companion,
      sourcePage: 10,
      badge: 'لكل قسم',
      iconName: 'maqari',
    ),
    Program(
      id: 'prog-mutun',
      name: 'المتون',
      kind: ProgramKind.companion,
      sourcePage: 10,
      badge: 'تحفة الأطفال · الجزرية · الشاطبية',
      items: ['تحفة الأطفال', 'الجزرية', 'الشاطبية'],
      iconName: 'mutun',
    ),
  ];

  static List<Program> get allPrograms => [
        ...departments,
        ...specialSections,
        ...companionPrograms,
      ];

  // ── Page 13 — قسم الشهادات ──────────────────────────────────────────────
  static const List<String> certificateKinds = [
    'شهادات تعليمية',
    'شهادات تقديرية',
    'إجازات',
  ];

  static const String certificatesDescription =
      'إصدار وتنظيم الشهادات التعليمية والتقديرية والإجازات للمتعلمين '
      'والكوادر، وتوثيق اجتياز البرامج والدورات، وفق معايير وضوابط معتمدة، '
      'مع حفظ السجلات وأرشفة الشهادات إلكترونياً بما يضمن دقة التوثيق '
      'وجودة المخرجات.';

  // ── Page 11 — قسم الإعلام والإعلان والتصاميم ────────────────────────────
  static const String mediaDescription =
      'نقدّم مجموعة متكاملة من الخدمات، تشمل: إعداد المحتوى الإعلامي '
      'والتعريفي، وتصميم الإعلانات والبطاقات والمنشورات التعليمية، وتغطية '
      'البرامج والأنشطة والإنجازات، بما يعزز حضور المؤسسة ويبرز رسالتها '
      'ومخرجاتها بصورة احترافية.';

  static const List<String> mediaChannels = [
    'قنوات ومجموعات واتساب',
    'تلغرام',
    'وسائل التواصل الاجتماعي',
  ];

  // ── Page 14 — آفاق مستقبلية ─────────────────────────────────────────────
  static const List<String> futureHorizons = [
    'التوسع في نشر التعليم القرآني والشرعي مجاناً',
    'تطوير البرامج والمسارات التعليمية',
    'توسيع نطاق التعليم الإلكتروني',
    'الوصول إلى مستفيدين من مختلف الدول واللغات',
    'بناء منظومة تعليمية متكاملة ذات أثر علمي وتربوي مستدام',
    'ترسيخ الأخلاق والقيم الإسلامية',
  ];

  static const String futureHorizonsClosing =
      'ليقترن العلم بالعمل، والقرآن بالسلوك، والتعليم بالتربية.';

  // ── Gaps in the source, recorded so the UI can be honest about them ─────
  /// Listed in the table of contents (page 2) but given no detail page.
  static const List<String> documentedGaps = [
    'قسم التقنيات التعليمية والعالمية',
    'الكادر التعليمي',
  ];
}
