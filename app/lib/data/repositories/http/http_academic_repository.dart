import '../../api/api_client.dart';
import '../../models/academic.dart';
import '../../models/data_origin.dart';
import '../repositories.dart';

/// [AcademicRepository] against the real backend (`/academic`).
///
/// Read-only: the app asks for the catalogue, one program, one halaqa and the
/// caller's own record. Management routes exist on the server for staff
/// tools; this app has none.
class HttpAcademicRepository implements AcademicRepository {
  HttpAcademicRepository(this._api);

  final ApiClient _api;

  @override
  DataOrigin get origin => DataOrigin.records;

  @override
  Future<List<AcademicSection>> catalogue() => _call(() async {
    final json = await _api.get('/academic/sections');
    return AcademicSection.listFromJson(json['sections']);
  });

  @override
  Future<AcademicProgramDetail?> program(String programId) => _find(
    () async => AcademicProgramDetail.fromJson(
      await _api.get('/academic/programs/${Uri.encodeComponent(programId)}'),
    ),
    notFound: 'academic.program_not_found',
  );

  @override
  Future<AcademicHalaqaDetail?> halaqa(String halaqaId) => _find(
    () async => AcademicHalaqaDetail.fromJson(
      await _api.get('/academic/halaqat/${Uri.encodeComponent(halaqaId)}'),
    ),
    notFound: 'academic.halaqa_not_found',
  );

  @override
  Future<MyAcademic> me() =>
      _call(() async => MyAcademic.fromJson(await _api.get('/academic/me')));

  static const _unreadable = AcademicException(
    'academic.unreadable',
    'The server sent something this app cannot read.',
  );

  /// Maps every transport failure to [AcademicException].
  static Future<T> _call<T>(Future<T> Function() work) async {
    try {
      return await work();
    } on ApiException catch (error) {
      throw AcademicException(error.code, error.message);
    } on FormatException {
      throw _unreadable;
    } on TypeError {
      throw _unreadable;
    }
  }

  /// A 404 carrying [notFound] — and only that code — means there is no such
  /// thing: null. Any other refusal stays a refusal.
  static Future<T?> _find<T>(
    Future<T> Function() work, {
    required String notFound,
  }) => _call<T?>(() async {
    try {
      return await work();
    } on ApiException catch (error) {
      if (error.status == 404 && error.code == notFound) return null;
      rethrow;
    }
  });
}
