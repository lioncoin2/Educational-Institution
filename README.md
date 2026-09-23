# المؤسسة العالمية لتعليم القرآن الكريم وعلومه الشرعية السبعة — منصّة تعليمية

منصّة تعليمية للمؤسسة: تطبيق **Flutter** (Mobile-first مع دعم Web)،
و**Backend** مبني على NestJS/TypeScript بمعمارية Modular Monolith.

## 🚦 حالة المشروع

| المكوّن | الحالة |
|---|---|
| **تطبيق Flutter** (`app/`) | ✅ يعمل تجريبياً بلا خادم (بيانات معلَّمة)، أو مع الخادم عبر `API_BASE_URL`: الدخول والرسائل والإشعارات والبيانات الأكاديمية حقيقية |
| **أساس المعمارية** (`backend/`) | ✅ Foundation V1 — الأساس والحدود والوحدات الأولى |
| **الهوية والصلاحيات** (Identity & Access V1) | ✅ تسجيل الدخول، رموز تحديث دوّارة، جلسات لكل جهاز، إدارة الحسابات من قِبل الموظفين، سجلّ تدقيق في PostgreSQL |
| **المراسلة والاتصال المباشر والإشعارات** | ✅ Messaging V1 · Realtime Messaging V1 · Notifications V1 |
| **النواة الأكاديمية** (Academic Core V1) | ✅ الأقسام والبرامج والحلقات من الملف التعريفي، التسجيل وتكليف المعلّمات مع السجلّ التاريخي، صلاحيات على مستوى الحلقة |
| الوحدات المكتملة في الـ Backend | `identity` · `live` (الغرف الصوتية) · `files` · `messaging` · `realtime` · `notifications` · `academic` |
| الوحدات المُعرَّفة كحدود فقط | `people` · `operations` · `assignments` · `automation` · `reporting` |

> **الأساس ليس منتجاً جاهزاً للإنتاج.** ما لم يُنفَّذ ويُختبر فعلياً موثَّق صراحةً
> في مستندات المعمارية تحت عنوان *Deferred* — ولم يُجرَ بعد أي اختبار حِمل
> (Load Testing) لمتطلّب الـ 2500 مشارك.

## 📁 المستندات

### معمارية النظام (`backend/`)

| الملف | الوصف |
|---|---|
| [`docs/architecture/overview.md`](docs/architecture/overview.md) | **ابدأ من هنا** — شكل النظام، الوحدات، الطبقات، وما لم يُبنَ عمداً |
| [`docs/architecture/dependency-rules.md`](docs/architecture/dependency-rules.md) | قواعد الاعتماد المُلزِمة — مُطبَّقة آلياً وتُفشِل البناء عند مخالفتها |
| [`docs/architecture/module-boundaries.md`](docs/architecture/module-boundaries.md) | مسؤولية كل وحدة، وما **لا** يجوز لها معرفته |
| [`docs/architecture/authentication.md`](docs/architecture/authentication.md) | تسجيل الدخول، الرموز، كلمات المرور، إنشاء الحسابات |
| [`docs/architecture/session-management.md`](docs/architecture/session-management.md) | الجلسات لكل جهاز، تدوير رموز التحديث، إنهاء الجلسات |
| [`docs/architecture/authorization.md`](docs/architecture/authorization.md) | الصلاحيات والسياسات — نقطة قرار واحدة مركزية |
| [`docs/architecture/realtime.md`](docs/architecture/realtime.md) | تصميم الغرف الصوتية (‏2500 مشارك)، وما ثبت منه وما لم يثبت |
| [`docs/architecture/events.md`](docs/architecture/events.md) | الأحداث بين الوحدات |
| [`docs/architecture/messaging.md`](docs/architecture/messaging.md) | حدود وحدة المراسلة |
| [`docs/architecture/notifications.md`](docs/architecture/notifications.md) | الإشعارات: الصندوق المحفوظ، التفضيلات، الأجهزة |
| [`docs/architecture/academic.md`](docs/architecture/academic.md) | النواة الأكاديمية: الأقسام والبرامج والحلقات، التسجيل، التكليف، الصلاحيات، التهيئة من الملف التعريفي |
| [`docs/architecture/storage.md`](docs/architecture/storage.md) | الملفات والتخزين |
| [`docs/architecture/persistence.md`](docs/architecture/persistence.md) | قاعدة البيانات واستراتيجية الترحيل |
| [`docs/architecture/observability.md`](docs/architecture/observability.md) | السجلّات، سجلّ التدقيق، الفحوص الصحّية |
| [`docs/architecture/open-questions.md`](docs/architecture/open-questions.md) | **الأسئلة المفتوحة** — قرارات مؤسسية لم تُخمَّن عمداً |
| [`docs/architecture/decisions/`](docs/architecture/decisions/) | سجلّات القرارات المعمارية (ADRs) |

### مواصفة الواجهات والمصدر المؤسسي

| الملف | الوصف |
|---|---|
| [`docs/prototype-spec.md`](docs/prototype-spec.md) | **المواصفة الكاملة** — 16 قسماً (A–P): نظرة المنتج، المستخدمون، بنية المعلومات، التنقّل، 56 شاشة، رحلات المستخدمين الثلاث، نظام التصميم، بنية المشروع، اعتبارات Web/iOS، التوسعات المستقبلية |
| [`docs/pdf-content-extract.md`](docs/pdf-content-extract.md) | **المحتوى المستخرج حرفياً** من الملف التعريفي، صفحةً بصفحة — مرجع التحقّق |
| [`docs/institution-profile.pdf`](docs/institution-profile.pdf) | الملف التعريفي للمؤسسة (14 صفحة) — **المصدر الوحيد لمعلومات المؤسسة** |

## 🔐 الأمن

لا توجد أسرار داخل تطبيق Flutter — ولا مفتاح LiveKit. العميل يستلم رمز دخول
قصير الأجل تُصدره الخادم فقط. لا تُرفع أي بيانات اعتماد إلى Git، ولا يوجد
حساب افتراضي أو كلمة مرور افتراضية في المستودع.

## ⚙️ التشغيل

```bash
# الواجهات
cd app && flutter pub get && flutter run

# الخادم (يعمل بلا قاعدة بيانات: يستخدم مُهايئات داخل الذاكرة)
cd backend && npm ci && npm run start:dev

# بوّابة الجودة قبل أي دفع
cd backend && npm run verify
```

## ⚠️ حدود المرحلة الحالية

- بلا خادم تعمل واجهات `app/` على **Mock Data** معلَّمة. مع الخادم: الدخول والرسائل والإشعارات
  والبيانات الأكاديمية حقيقية؛ الدروس والحضور والتقدّم والشهادات والإعلانات ما زالت تجريبية،
  ولا يُعرض تقدّم غير مسجَّل.
- لا واجهة لغرفة الـ 2500 مشارك، ولا لوحة للمعلّمة أو للإدارة (خارج نطاق هذه المرحلة عمداً).
- كل بيان غير موجود في الملف التعريفي **مُعلَّم صراحةً كـ Mock Data**.

## 📌 الخطوة التالية

الإجابة على الأسئلة المفتوحة في
[`docs/architecture/open-questions.md`](docs/architecture/open-questions.md) —
وأهمّها **Q1** (صلاحيات كل دور) و**Q2** (كيفية إنشاء حساب المالك الأول)،
إذ تعتمد عليهما بقية وحدات النظام.
