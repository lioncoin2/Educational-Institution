import '../../api/api_client.dart';
import '../../models/command_center.dart';
import '../../models/data_origin.dart';
import '../repositories.dart';

/// [ReportingRepository] against the real backend (`/reporting`).
///
/// Read-only: it asks for the command center and returns exactly what the
/// server resolved — the server authorizes and filters, so the app adds no
/// gate. Every transport or parse failure becomes a [ReportingException],
/// keeping the server's code.
class HttpReportingRepository implements ReportingRepository {
  HttpReportingRepository(this._api);

  final ApiClient _api;

  @override
  Future<CommandCenter> commandCenter() => _call(() async {
    final json = await _api.get('/reporting/command-center');
    return CommandCenter.fromJson(json, origin: DataOrigin.records);
  });

  static const _unreadable = ReportingException(
    'reporting.unreadable',
    'The server sent something this app cannot read.',
  );

  static Future<T> _call<T>(Future<T> Function() work) async {
    try {
      return await work();
    } on ApiException catch (error) {
      throw ReportingException(error.code, error.message);
    } on FormatException {
      throw _unreadable;
    } on TypeError {
      throw _unreadable;
    }
  }
}
