import 'package:flutter/material.dart';

import '../../extensions/context_ext.dart';

/// A round avatar: a picture when there is one, the first letter otherwise.
///
/// Purely presentational — it never fetches anything. A caller that has a
/// picture resolves its short-lived link first (through a repository) and
/// passes [imageUrl]; with no link, or when the image fails to load, the
/// avatar falls back to [name]'s first letter on the maroon surface. This is
/// the one place a profile picture is drawn, so the default (initials) view is
/// consistent everywhere identity is shown.
class AppAvatar extends StatelessWidget {
  const AppAvatar({super.key, this.name, this.imageUrl, this.radius = 22});

  /// The display name the initials come from.
  final String? name;

  /// A ready-to-load link to the picture, or null for the initials view.
  final Uri? imageUrl;

  final double radius;

  @override
  Widget build(BuildContext context) {
    final background = context.colors.primaryContainer;
    final foreground = context.colors.onPrimaryContainer;
    final initials = _initial(name);
    final fallback = Text(
      initials,
      style: context.text.titleMedium?.copyWith(color: foreground),
    );
    return CircleAvatar(
      radius: radius,
      backgroundColor: background,
      child: imageUrl == null
          ? fallback
          : ClipOval(
              child: Image.network(
                imageUrl.toString(),
                width: radius * 2,
                height: radius * 2,
                fit: BoxFit.cover,
                // No picture yet, or it failed: keep the initials, never a gap.
                errorBuilder: (_, _, _) => fallback,
                loadingBuilder: (context, child, progress) =>
                    progress == null ? child : fallback,
              ),
            ),
    );
  }

  static String _initial(String? name) {
    final trimmed = name?.trim() ?? '';
    return trimmed.isEmpty ? '؟' : String.fromCharCode(trimmed.runes.first);
  }
}
