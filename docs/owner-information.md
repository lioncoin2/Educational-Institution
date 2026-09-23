# Owner information — statements received after Academic Core V1

> **Status: owner statement · mapping to the printed profile unconfirmed · NOT
> implemented.**
>
> This file records what the institution's owner has said about its academic
> organisation, **as it was relayed**, so the facts can be cited and are not
> lost. It is the project's **third source**, kept apart from the other two:
>
> | Source | Where | What it is |
> | --- | --- | --- |
> | The printed profile | `docs/institution-profile.pdf`, transcribed page by page in [`pdf-content-extract.md`](pdf-content-extract.md) | The institution's published document (14 pages) |
> | **Owner statements** | **this file** | What the owner said later, dated, in their own terms |
> | Engineering provisional assumptions | [`architecture/open-questions.md`](architecture/open-questions.md) | What engineering had to assume to build anything; each one labelled and open |
>
> **Rules for this file:**
>
> - Nothing here is in the seed, the database, the app or a test. The seeded
>   structure is still the printed profile's
>   (`backend/src/modules/academic/application/institution-structure.json`).
> - A statement here is **not** evidence for a rule it does not state. List
>   order is not a sequence; "halaqat" is not a capacity; a named stage is not
>   a promotion criterion.
> - Owner wording is **never** copied into `pdf-content-extract.md`. That file
>   is the printed profile only, and the seed's provenance test matches names
>   anywhere in it
>   (`backend/src/modules/academic/application/seed.spec.ts`).
> - A statement moves into the structure only through an ADR that records the
>   owner's answer to the matching open question (Q35–Q39), with the date and
>   the mapping of each code to its name.
>
> The analysis of what these statements mean for the code is in
> [`architecture/academic-reconciliation.md`](architecture/academic-reconciliation.md).

---

## Received

| | |
| --- | --- |
| Date received | 2026-09-23 |
| How | Relayed to engineering in the project conversation, after Academic Core V1 was complete (commit `dffb156`). Not a document from the institution. |
| Language | Arabic names exactly as relayed; the connecting sentences were relayed in English and are kept as relayed, not re-translated. |

---

## The statements, as relayed

### S1 — Seven core academic sections

The core academic sections are:

1. محو الأمية
2. تلقين الحروف
3. المبتدئ
4. تجويد الحروف
5. التجويد المتوسط
6. التجويد المتقدم
7. دورة التهجي وإعداد المعلمات

**Not stated:** whether these are all of the institution's sections or the
core ones among others; whether the numbering is an order of study or a list;
which printed-profile section each one is.

### S2 — Halaqat per section

> Each section has 10 basic halaqat, with the ability to open additional
> halaqat according to level and need.

**Not stated:** whether "10" is what runs today or a standard; whether it
applies to every one of the seven (the printed profile gives محو الأمية 5);
whether a basic halaqa differs from an additional one once opened; what
"level" and "need" mean; who opens or closes a halaqa; any limit.

### S3 — Progression

> Progression involves: assessment/evaluation, appropriate placement, mastery,
> progression to higher levels, strengthening/support, later
> specialization/training/teacher preparation.

**Not stated:** any criterion, score, form, threshold or duration; who
assesses or places; whether assessment is recorded; whether levels are
sections, halaqat or something else; whether strengthening is a separate
halaqa, a status or help inside the same halaqa.

### S4 — A broader development path

> Educational level, mastery, specialization, training, teacher preparation,
> leadership/management.

**Not stated:** whether these are stages the institution runs as sections or
programs with enrolled learners, or staff roles and qualifications; how they
relate to the printed profile's page 12 «تأهيل و بناء الكوادر» (four tracks)
and page 5 «مجالات التعليم و التخصص» (six fields).

### S5 — «نظام الضخ بين الأقسام»

The phrase as relayed, with no further description.

**Not stated:** what is moved (a student, a group, a trained teacher), in
which direction, who decides, when, and how the place left behind is
recorded.

### S6 — «مدينة التهجي»

> «مدينة التهجي» with 40 specialized groups and teacher preparation.

As relayed, it is **unclear** whether this is:

- **(A)** the same structure as «دورة التهجي وإعداد المعلمات» (S1, item 7), or
- **(B)** a separate specialised structure.

**Not stated:** whether a "group" is a halaqa; whether 40 groups exist today
or 40 is the number it can hold (the printed profile's page 7 says
«استيعاب 40 مجموعة» under «قسم التهجي»); how the 40 groups relate to the 10
basic halaqat of S2.

---

## What the printed profile says on the same subjects

For comparison only — quoted from [`pdf-content-extract.md`](pdf-content-extract.md),
not re-interpreted:

| Subject | Printed profile | Page |
| --- | --- | --- |
| Graded sections | قسم محو الأمية (5 حلقات)، قسم تلقين الحروف (10)، قسم تجويد مبتدئ (10)، قسم تجويد متوسط (10)، قسم تجويد متقدم (10) | 6 |
| التهجي | «قسم التهجي» — teaching letters, harakat, correct reading, makharij; «استيعاب 40 مجموعة»; no mention of teacher preparation | 7 |
| Other sections | قسم البراعم (3 مستويات)، قسم اللغات (5 لغات) | 8–9 |
| Accompanying programs | مدينة الحفاظ، علوم النحو، المقارئ، المتون | 10 |
| Cadre development | «تأهيل و بناء الكوادر»: تأهيل مشرفات، تأهيل معلمات، التدريب على إدارة الحلقات، التدريب على إدارة الاقسام | 12 |
| Certificates | documents «اجتياز البرامج و الدورات وفق معايير و ضوابط معتمدة»; no criteria stated | 13 |
| Audiences | البراعم، الناشئات، كبار السن، غير الناطقين باللغة العربية، محو الأمية | 4 |

---

## أسئلة للمالكة — للإجابة قبل أي تعديل على الهيكل

> الغرض من هذه الأسئلة هو **معرفة ما تعمل به المؤسسة فعلاً**، لا اقتراح قواعد.
> لن يُفترض أي جواب. السؤال الذي لا يُجاب كتابةً يبقى مفتوحاً. أرقام الأسئلة
> بين القوسين تشير إلى [`architecture/open-questions.md`](architecture/open-questions.md).

### أ. الأقسام السبعة (Q35)

1. هل الأقسام السبعة هي **كل** أقسام المؤسسة التعليمية اليوم، أم هي الأقسام
   الأساسية بين أقسام أخرى؟
2. هل «المبتدئ» هو «قسم تجويد مبتدئ» في الملف التعريفي (ص6)؟ أم أن «تجويد
   الحروف» هو الاسم الجديد لذلك القسم؟ أم أن كليهما قسمان جديدان؟
3. هل قسم «تجويد الحروف» قائم الآن بحلقات، أم مُخطَّط له؟
4. الملف التعريفي يذكر لمحو الأمية **5 حلقات**، وذكرتم 10 حلقات أساسية لكل
   قسم. أيّ الرقمين هو الحالي لمحو الأمية؟
5. هل «10 حلقات أساسية» تعني عشر حلقات قائمة اليوم، أم العدد المعتاد للقسم؟
6. بعد فتح حلقة إضافية: هل تُعامَل بشكل مختلف عن الحلقة الأساسية؟ هل يلزم
   النظام أن يميّز بينهما؟
7. من يفتح الحلقة الإضافية ومن يغلقها؟ هل يحتاج ذلك إلى موافقة؟
8. ما المقصود بـ«حسب المستوى والحاجة»: هل «الحاجة» عدد الطالبات المنتظرات،
   أم فئة معيّنة (مثل الناشئات، كبار السن، غير الناطقين بالعربية — ص4)؟
9. داخل القسم الواحد: هل الحلقات **مستويات متتالية** تمر بها الطالبة، أم
   **مجموعات متوازية** في المستوى نفسه؟
10. هل للحلقات أسماء، أم تُعرف بأرقامها؟
11. هل الترقيم من 1 إلى 7 هو ترتيب **العرض** المطلوب في التطبيق؟ (سؤال عن
    العرض فقط، وليس قاعدة انتقال.)
12. عند اعتماد أسمائكم للأقسام: هل يبقى اسم الملف التعريفي المطبوع محفوظاً
    (اسماً رسمياً مثلاً)، أم يحل اسمكم محله تماماً؟ وهل يُكتب «قسم» قبل الاسم؟

### ب. التهجي (Q36)

13. هل «دورة التهجي وإعداد المعلمات» هي «قسم التهجي» في الملف التعريفي (ص7)؟
14. هل «مدينة التهجي» هي **(أ)** نفس «دورة التهجي وإعداد المعلمات»، أم
    **(ب)** بنية مستقلة؟ وإن كانت مستقلة: هل هي قسم مستقل، أم جزء من دورة
    التهجي، أم برنامج مرافق مثل «مدينة الحفاظ»؟
15. «المجموعة» في التهجي: هل هي حلقة كسائر الحلقات (طالبات مسجّلات ومعلمة
    مكلّفة)، أم مجموعة أصغر داخل الحلقة، أم مجموعة واتساب/تلغرام؟
16. هل توجد **40 مجموعة قائمة الآن**، أم أن 40 هو **الحد الذي تستوعبه** البنية
    (الملف يقول «استيعاب 40 مجموعة»)؟
17. ما علاقة الـ40 مجموعة بالحلقات العشر الأساسية؟
18. من يدرس في دورة التهجي وإعداد المعلمات: طالبات من الأقسام الأخرى، أم
    متقدمات جديدات، أم معلمات قائمات على رأس العمل؟
19. هل تعمل الدورة على شكل **دفعات** لها بداية ونهاية، أم بشكل مستمر؟ وإن
    كانت دفعات: هل تُفتح المجموعات من جديد لكل دفعة؟
20. هل الدورة خطوة على المسار نفسه مع الأقسام الستة الأخرى، أم مسار منفصل؟
    (سؤال عن الوصف، لا عن قاعدة.)

### ج. الانتقال بين الحلقات والأقسام (Q37)

21. هل يُسجَّل **التقييم** في النظام؟ إن كان كذلك: من يقوم به، وهل يُسجَّل
    القرار وحده أم نتيجة أيضاً؟ وهل يكون قبل التسكين الأول، أو بين
    المستويات، أو كليهما؟
22. هل تستخدم المؤسسة **نموذج تقييم معتمداً** للتلاوة؟ ماذا يسجّل؟ (النموذج
    الظاهر في النموذج الأولي — الإتقان/التجويد/الطلاقة، مقبول/إعادة — مُختلَق
    ولن يُستخدم ما لم تؤكّدوه.)
23. هل هناك مرحلة تكون فيها الطالبة مسجّلة في المؤسسة لكن لم تُقيَّم أو
    تُسكَّن بعد؟ هل يجب أن يُظهرها التطبيق؟
24. من يسكّن الطالبة وينقلها: الإدارة، أو رئيسة القسم، أو المشرفة، أو
    المعلمة، أو لجنة تقييم؟
25. ما هو **«نظام الضخ بين الأقسام»** بالتحديد؟ ماذا ينقل (طالبة، أم حلقة
    كاملة، أم معلمات مؤهَّلات)؟ في أي اتجاه؟ ومن يقرّر؟
26. عندما تغادر الطالبة حلقة لأنها نُقلت (بعد تقييم، أو للتقوية، أو بالضخ):
    ماذا يُسجَّل لتلك الحلقة — «أتمّت»، أم «انسحبت»، أم شيء آخر؟ ما الكلمات
    التي تستخدمها المؤسسة لكل نوع انتقال؟
27. هل يجب أن تُسجَّل حلقات الطالبة المتتالية **مساراً واحداً متصلاً**
    («انتقلت من س إلى ص»)؟
28. **التقوية/الدعم**: هل هي حلقة منفصلة تحضرها الطالبة إلى جانب حلقتها أو
    بدلاً منها، أم مساعدة داخل الحلقة نفسها، أم حالة على الطالبة؟
29. هل يجوز أن تكون الطالبة في أكثر من حلقة في الوقت نفسه (مثلاً حلقتها
    وحلقة تقوية، أو قسم وبرنامج مرافق)؟
30. عند إغلاق حلقة أو دمجها: هل تُنقل طالباتها إلى حلقات أخرى؟ وهل يُسجَّل
    ذلك انتقالاً؟
31. هل يجوز أن ينقل التقييم الطالبة إلى مستوى أعلى مباشرة (تخطّي قسم)، أو
    إلى مستوى أدنى؟
32. هل **الإتقان** شيء يسجّله النظام لكل طالبة ومستوى، أم هو فقط سبب يذكره
    الطاقم عند النقل؟ (سؤال عن التسجيل، لا عن المعايير.)

### د. مسار التطوير وإعداد المعلمات (Q38)

33. هل مراحل مسار التطوير (التخصص، التدريب، إعداد المعلمات، القيادة
    والإدارة) أقسام أو برامج بحلقات وطالبات مسجّلات، أم أدوار ومؤهلات للطاقم؟
34. هل هي نفسها مسارات الصفحة 12 (تأهيل مشرفات، تأهيل معلمات، التدريب على
    إدارة الحلقات، التدريب على إدارة الأقسام)؟
35. هل «التخصص» هو أحد مجالات الصفحة 5 (القرآن حفظاً وإتقاناً، العلوم
    الشرعية، التجويد والقراءات، …)؟ وأيّ الأقسام أو البرامج تخدم كل مجال؟
36. هل «الإتقان» مرحلة تديرها المؤسسة ببرنامج خاص (مثل مدينة الحفاظ)، أم
    شيء تُظهره الطالبة داخل قسمها؟
37. من يشارك في إعداد المعلمات: طالبات، أم معلمات حاليات، أم الجميع؟ وعندما
    تبدأ الخرّيجة بالتدريس، هل هو الحساب نفسه؟
38. هل يُشترط إتمام إعداد المعلمات قبل التكليف بالتدريس؟ أم لا يوجد شرط؟
39. أثناء الإعداد: هل تدرّس المتدرّبات أو تساعد في حلقات حقيقية (تطبيق
    عملي)؟ وإن كان كذلك، هل ترى قوائم طالبات تلك الحلقات؟
40. هل يجوز أن يكون الشخص نفسه طالبة في حلقة ومعلمة/مساعدة في حلقة أخرى في
    الوقت نفسه؟ وفي الحلقة نفسها؟
41. ما الذي تراه **المشرفة** وتفعله: كل القوائم، أم قوائم قسم معيّن، أم
    حلقات محدّدة؟ هل «إدارة الأقسام» دور مستقل؟
42. الملف التعريفي (ص13) يقول إن الشهادات توثّق «اجتياز البرامج والدورات وفق
    معايير وضوابط معتمدة». هل هذه المعايير مكتوبة؟ متى تُصدَر الشهادة أو
    الإجازة ومن يقرّر؟ (نسأل عن وجودها ومن يملكها، لا نقترح شيئاً.)

### هـ. ما هو خارج الأقسام السبعة (Q39)

43. هل ما زالت هذه قائمة: قسم البراعم (3 مستويات)، قسم اللغات (5 لغات)،
    والبرامج المرافقة (مدينة الحفاظ، علوم النحو، المقارئ، المتون)؟ أين تقع
    بالنسبة للأقسام السبعة؟
44. الصفحة 4 تذكر «البراعم» و«محو الأمية» فئتين مستهدفتين، وهما أيضاً اسما
    قسمين. هل البراعم قسم مستقل، أم فئة عمرية تدرس داخل الأقسام السبعة؟
45. هل وصف «الأقسام التعليمية الأساسية» يميّزها عن الأقسام غير التعليمية
    (قسم الإعلام ص11، قسم الشهادات ص13)، أم عن البراعم واللغات والبرامج
    المرافقة، أم عن الاثنين؟
46. هل «المقارئ — لكل قسم» تعني مقرأة لكل قسم؟

### و. العرض العام أثناء المراجعة

47. أثناء هذه المراجعة: هل يبقى العرض التجريبي المنشور (GitHub Pages) يُظهر
    هيكل الملف التعريفي (5 أقسام، 45 حلقة)، والمسار المقفل التجريبي، وشهادات
    العيّنة؟ أم يُوقَف أو يُعاد وسمه؟
48. هل ما زال الملف التعريفي المطبوع هو وثيقتكم العامة؟
