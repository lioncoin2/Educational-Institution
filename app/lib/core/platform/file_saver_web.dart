import 'dart:async';
import 'dart:js_interop';
import 'dart:typed_data';

import 'package:web/web.dart' as web;

/// Hands [bytes] to the browser as a download named [fileName]. The bytes stay
/// on the device: a local object URL, revoked a little after the download
/// starts (revoking at once can cancel it in some browsers).
void saveBytesAsFile(List<int> bytes, {required String fileName, required String mimeType}) {
  final blob = web.Blob(
    [Uint8List.fromList(bytes).toJS].toJS,
    web.BlobPropertyBag(type: mimeType),
  );
  final url = web.URL.createObjectURL(blob);
  final anchor = web.HTMLAnchorElement()
    ..href = url
    ..download = fileName
    ..style.display = 'none';
  web.document.body?.append(anchor);
  anchor.click();
  anchor.remove();
  Timer(const Duration(seconds: 30), () => web.URL.revokeObjectURL(url));
}
