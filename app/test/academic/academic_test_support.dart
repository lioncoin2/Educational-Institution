import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

/// The institution's structure exactly as the server seeds it — read from the
/// one canonical file the seed reads, so these tests and the backend can
/// never describe two different institutions.
Map<String, Object?> canonicalStructure() => jsonDecode(
  File('../backend/src/modules/academic/application/institution-structure.json')
      .readAsStringSync(),
) as Map<String, Object?>;

const _at = '2026-09-01T08:00:00.000Z';

http.Response jsonResponse(int status, Object body) => http.Response(
  jsonEncode(body),
  status,
  headers: {'content-type': 'application/json; charset=utf-8'},
);

http.Response refusal(int status, String code) => jsonResponse(status, {
  'error': {'kind': 'x', 'code': code, 'message': code},
});

/// A scripted `/academic` backend: the wire shapes the server returns
/// (backend/src/modules/academic/api/responses.ts), built from the canonical
/// structure — server ids are `s:`, `p:` and `h:` + the code, so no test can
/// pass by confusing an id with a code.
class AcademicServer {
  AcademicServer() {
    final structure = canonicalStructure();
    for (final section in structure['sections']! as List<Object?>) {
      final s = (section! as Map).cast<String, Object?>();
      final code = s['code']! as String;
      final programs = <Map<String, Object?>>[];
      for (final program in s['programs']! as List<Object?>) {
        final p = (program! as Map).cast<String, Object?>();
        final programCode = p['code']! as String;
        final count = p['halaqat']! as int;
        programs.add({
          'id': 'p:$programCode',
          'code': programCode,
          'sectionId': 's:$code',
          'name': p['name'],
          'order': p['order'],
          'description': null,
          'status': 'ACTIVE',
          'activeHalaqaCount': count,
          'createdAt': _at,
          'updatedAt': _at,
        });
        halaqatOf['p:$programCode'] = [
          for (var n = 1; n <= count; n++)
            {
              'id': 'h:$code-h$n',
              'code': '$code-h$n',
              'programId': 'p:$programCode',
              'name': 'الحلقة $n',
              'order': n,
              'status': 'ACTIVE',
              'createdAt': _at,
              'updatedAt': _at,
            },
        ];
      }
      sections.add({
        'id': 's:$code',
        'code': code,
        'name': s['name'],
        'kind': s['kind'],
        'order': s['order'],
        'description': null,
        'status': 'ACTIVE',
        'createdAt': _at,
        'updatedAt': _at,
        'programs': programs,
      });
    }
  }

  /// The catalogue, as `GET /academic/sections` lists it — edit freely.
  final List<Map<String, Object?>> sections = [];

  /// Each program's halaqat, by the program's server id.
  final Map<String, List<Map<String, Object?>>> halaqatOf = {};

  /// `GET /academic/me`.
  Map<String, Object?> me = {
    'enrollments': <Object?>[],
    'teaching': <Object?>[],
    'truncated': false,
  };

  /// `GET /auth/me` — who the tokens belong to.
  Map<String, Object?> user = {
    'id': 'u-student',
    'displayName': 'مريم',
    'status': 'ACTIVE',
    'roles': ['STUDENT'],
    'permissions': ['academic.read', 'academic.study'],
  };

  /// "GET /academic/me" → the refusal to answer instead, while it is set.
  final Map<String, http.Response Function()> refuse = {};

  /// When set, every answer waits for it — to see loading states.
  Completer<void>? hold;

  final List<http.Request> requests = [];

  /// "METHOD /path", decoded — as a test would write it.
  List<String> get calls => [for (final request in requests) _key(request)];

  static String _key(http.Request request) =>
      '${request.method} ${Uri.decodeComponent(request.url.path)}';

  late final http.Client client = MockClient((request) async {
    requests.add(request);
    if (hold case final gate?) await gate.future;
    if (refuse[_key(request)] case final refused?) return refused();
    if (request.headers['authorization'] != 'Bearer a1') {
      return refusal(401, 'identity.authentication_required');
    }
    return _answer(request.url.path) ?? refusal(404, 'not_found');
  });

  http.Response? _answer(String path) {
    if (path == '/auth/me') return jsonResponse(200, user);
    if (path == '/academic/sections') {
      return jsonResponse(200, {'sections': sections});
    }
    if (path == '/academic/me') return jsonResponse(200, me);
    final program = RegExp(r'^/academic/programs/(.+)$').firstMatch(path);
    if (program != null) {
      final id = Uri.decodeComponent(program.group(1)!);
      final found = _program(id);
      if (found == null) return refusal(404, 'academic.program_not_found');
      final (section, entry) = found;
      return jsonResponse(200, {
        'program': entry,
        'section': {...section}..remove('programs'),
        'halaqat': halaqatOf[id] ?? const [],
      });
    }
    final halaqa = RegExp(r'^/academic/halaqat/(.+)$').firstMatch(path);
    if (halaqa != null) {
      final placed = placement(Uri.decodeComponent(halaqa.group(1)!));
      if (placed == null) return refusal(404, 'academic.halaqa_not_found');
      final entry = halaqatOf[placed['program']!['id']]!.firstWhere(
        (h) => h['id'] == placed['halaqa']!['id'],
      );
      return jsonResponse(200, {
        'halaqa': entry,
        'program': placed['program'],
        'section': placed['section'],
      });
    }
    return null;
  }

  (Map<String, Object?>, Map<String, Object?>)? _program(String id) {
    for (final section in sections) {
      for (final program
          in (section['programs']! as List).cast<Map<String, Object?>>()) {
        if (program['id'] == id) return (section, program);
      }
    }
    return null;
  }

  Map<String, Object?> section(String code) =>
      sections.firstWhere((s) => s['code'] == code);

  /// Where a halaqa sits, as relationships refer to it.
  Map<String, Map<String, Object?>>? placement(String halaqaId) {
    for (final section in sections) {
      for (final program
          in (section['programs']! as List).cast<Map<String, Object?>>()) {
        for (final halaqa in halaqatOf[program['id']] ?? const []) {
          if (halaqa['id'] != halaqaId) continue;
          Map<String, Object?> ref(Map<String, Object?> of) => {
            'id': of['id'],
            'code': of['code'],
            'name': of['name'],
            'order': of['order'],
            'status': of['status'],
          };
          return {
            'section': {...ref(section), 'kind': section['kind']},
            'program': ref(program),
            'halaqa': ref(halaqa),
          };
        }
      }
    }
    return null;
  }

  /// Makes the signed-in student enrolled in [halaqaId] — as the server
  /// would list it under `/academic/me`, with the halaqa's teachers.
  void enroll(
    String halaqaId, {
    List<Map<String, Object?>> teachers = const [],
    String status = 'ACTIVE',
    String enrolledAt = _at,
  }) {
    (me['enrollments']! as List<Object?>).add({
      'enrollment': {
        'id': 'e:$halaqaId',
        'studentUserId': user['id'],
        'halaqaId': halaqaId,
        'status': status,
        'enrolledAt': enrolledAt,
        'endedAt': status == 'ACTIVE' ? null : enrolledAt,
      },
      'placement': placement(halaqaId),
      'teachers': teachers,
    });
  }
}
