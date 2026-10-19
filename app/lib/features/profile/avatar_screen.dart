import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/extensions/context_ext.dart';
import '../../core/theme/app_tokens.dart';
import '../../core/widgets/foundations/app_avatar.dart';
import '../../core/widgets/layout/responsive_body.dart';
import '../../data/models/files.dart';
import '../../providers/app_providers.dart';

/// The signed-in user sets or removes their profile picture.
///
/// A picture is an image the user uploads through the files flow, then points
/// their account at. The server verifies it is an image the caller owns before
/// it is stored; this screen only drives the flow and shows the result. With no
/// picture, the default (initials) view is shown — a picture is never required.
class AvatarScreen extends ConsumerStatefulWidget {
  const AvatarScreen({super.key});

  @override
  ConsumerState<AvatarScreen> createState() => _AvatarScreenState();
}

class _AvatarScreenState extends ConsumerState<AvatarScreen> {
  bool _busy = false;

  Future<void> _run(Future<void> Function() action, String done) async {
    if (_busy) return;
    setState(() => _busy = true);
    try {
      await action();
      // The session carries the new reference; the header and this screen both
      // re-resolve the link.
      ref.invalidate(sessionUserProvider);
      ref.invalidate(ownAvatarUrlProvider);
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(done)));
    } on FilesException catch (error) {
      if (!mounted) return;
      ScaffoldMessenger.of(
        context,
      ).showSnackBar(SnackBar(content: Text(_describe(error.code))));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _choose() async {
    final picker = ref.read(attachmentPickerProvider);
    if (!picker.isAvailable) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('اختيار الصور غير متاح على هذا الجهاز.')),
      );
      return;
    }
    final image = await picker.pickImage();
    if (image == null) return; // cancelled
    await _run(() async {
      final files = ref.read(filesRepositoryProvider);
      final assetId = await files.uploadImage(image);
      await files.setMyAvatar(assetId);
    }, 'تم تحديث الصورة الشخصية.');
  }

  Future<void> _remove() => _run(
    () => ref.read(filesRepositoryProvider).removeMyAvatar(),
    'تمت إزالة الصورة الشخصية.',
  );

  String _describe(String code) => switch (code) {
    'files.asset_kind_not_accepted' => 'اختر صورة (JPEG أو PNG أو WebP).',
    'files.too_large' => 'الصورة كبيرة جدًّا.',
    'files.asset_not_found' => 'تعذّر العثور على الصورة المرفوعة.',
    'network.unreachable' => 'تعذّر الاتصال. حاول مجددًا.',
    _ => 'تعذّر تحديث الصورة. حاول مجددًا.',
  };

  @override
  Widget build(BuildContext context) {
    final session = ref.watch(sessionUserProvider);
    final avatarUrl = ref.watch(ownAvatarUrlProvider).value;
    final name = session.value?.displayName;
    final hasPicture = session.value?.avatarFileAssetId != null;

    return Scaffold(
      appBar: AppBar(title: const Text('الصورة الشخصية')),
      body: SafeArea(
        top: false,
        child: ListView(
          padding: const EdgeInsets.symmetric(vertical: Insets.xxl),
          children: [
            ResponsiveBody(
              child: Column(
                children: [
                  AppAvatar(name: name, imageUrl: avatarUrl, radius: 56),
                  const SizedBox(height: Insets.lg),
                  Text(
                    'صورتك تظهر بجانب اسمك في المحادثات وملفك الشخصي. '
                    'عند غيابها يظهر الحرف الأول من اسمك.',
                    textAlign: TextAlign.center,
                    style: context.text.bodyMedium,
                  ),
                  const SizedBox(height: Insets.xl),
                  FilledButton.icon(
                    onPressed: _busy ? null : _choose,
                    icon: const Icon(Icons.photo_camera_outlined),
                    label: const Text('اختيار صورة'),
                  ),
                  const SizedBox(height: Insets.sm),
                  if (hasPicture)
                    TextButton.icon(
                      onPressed: _busy ? null : _remove,
                      icon: const Icon(Icons.delete_outline),
                      label: const Text('إزالة الصورة'),
                    ),
                  if (_busy) ...[
                    const SizedBox(height: Insets.lg),
                    const Center(child: CircularProgressIndicator()),
                  ],
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}
