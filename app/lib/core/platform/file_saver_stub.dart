/// Saving a file is a web-only capability (web-first Trial, ADR 0037). On every
/// other target this throws, and the caller tells the viewer.
void saveBytesAsFile(List<int> bytes, {required String fileName, required String mimeType}) =>
    throw UnsupportedError('Saving a file is only supported on the web build.');
