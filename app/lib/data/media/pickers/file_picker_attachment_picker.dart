import 'dart:typed_data';

import 'package:file_picker/file_picker.dart';

import '../../models/messaging.dart';
import '../media_seams.dart';

/// The real [AttachmentPicker], backed by `file_picker`.
///
/// This is the ONLY file that imports `package:file_picker`
/// (test/messaging/attachment_boundaries_test.dart enforces the confinement,
/// as the LiveKit and secure-storage adapters are confined — ADR 0030). It
/// picks only the kinds the backend's upload policy accepts (images:
/// jpg/jpeg/png/webp; documents: PDF — `backend/.../file-policy.ts`), reads the
/// bytes in a web-safe way (`PlatformFile.readAsBytes`, never `dart:io` and
/// never a fabricated path), and hands back a plain [OutgoingFile]. The upload
/// itself (declare → PUT → complete) and all authorization stay the HTTP
/// repository's and the server's.
///
/// The one call into the plugin is behind [PickFile] so the pure mapping
/// (extension → kind/content type, cancellation, empty selection) is
/// unit-tested without the plugin, which needs a real platform.

/// A picked file reduced to what an upload needs — SDK-free, so a test can
/// stand in for the plugin.
class PickedFile {
  const PickedFile(this.name, this.bytes);
  final String name;
  final Uint8List bytes;
}

/// Picks one file restricted to [extensions]; null when the person cancels.
typedef PickFile = Future<PickedFile?> Function(List<String> extensions);

const List<String> _imageExtensions = ['jpg', 'jpeg', 'png', 'webp'];
const List<String> _documentExtensions = ['pdf'];

/// Extension → the content type the backend's allow-list names for it. The
/// picker only offers these extensions, so a selection always maps.
const Map<String, String> _contentTypes = {
  'jpg': 'image/jpeg',
  'jpeg': 'image/jpeg',
  'png': 'image/png',
  'webp': 'image/webp',
  'pdf': 'application/pdf',
};

Future<PickedFile?> _pickWithPlugin(List<String> extensions) async {
  final picked = await FilePicker.pickFile(
    type: FileType.custom,
    allowedExtensions: extensions,
  );
  if (picked == null) return null;
  final bytes = await picked.readAsBytes();
  return PickedFile(picked.name, bytes);
}

class FilePickerAttachmentPicker implements AttachmentPicker {
  const FilePickerAttachmentPicker([PickFile pick = _pickWithPlugin]) : _pick = pick;

  final PickFile _pick;

  @override
  bool get isAvailable => true;

  @override
  Future<OutgoingFile?> pickImage() =>
      _pickAs(_imageExtensions, AttachmentKind.image);

  @override
  Future<OutgoingFile?> pickDocument() =>
      _pickAs(_documentExtensions, AttachmentKind.document);

  Future<OutgoingFile?> _pickAs(
    List<String> extensions,
    AttachmentKind kind,
  ) async {
    final PickedFile? picked;
    try {
      picked = await _pick(extensions);
    } on Object {
      // A cancelled picker, a denied permission or a failed read all land here:
      // a no-op is the graceful outcome — nothing is sent, nothing crashes.
      return null;
    }
    if (picked == null || picked.bytes.isEmpty) return null;
    return outgoingFromPicked(picked, kind);
  }
}

/// Maps a picked file to an [OutgoingFile], deriving a server-allowed content
/// type from its (allow-listed) extension. Pure, so it is unit-tested directly.
OutgoingFile outgoingFromPicked(PickedFile picked, AttachmentKind kind) {
  final extension = _extensionOf(picked.name);
  final contentType =
      _contentTypes[extension] ??
      (kind == AttachmentKind.image ? 'image/jpeg' : 'application/pdf');
  return OutgoingFile(
    bytes: picked.bytes,
    fileName: picked.name,
    contentType: contentType,
    kind: kind,
  );
}

String _extensionOf(String name) {
  final dot = name.lastIndexOf('.');
  if (dot <= 0 || dot == name.length - 1) return '';
  return name.substring(dot + 1).toLowerCase();
}
