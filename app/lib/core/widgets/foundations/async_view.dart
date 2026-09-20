import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../extensions/context_ext.dart';
import '../../theme/app_tokens.dart';

/// Single place where loading and error states are rendered, so every screen
/// behaves the same way while data resolves.
class AsyncView<T> extends StatelessWidget {
  const AsyncView({
    super.key,
    required this.value,
    required this.builder,
    this.loading,
    this.onRetry,
  });

  final AsyncValue<T> value;
  final Widget Function(BuildContext context, T data) builder;
  final Widget? loading;
  final VoidCallback? onRetry;

  @override
  Widget build(BuildContext context) {
    return value.when(
      data: (data) => builder(context, data),
      loading: () => loading ?? const _CenteredSpinner(),
      error: (error, _) => _ErrorState(onRetry: onRetry),
    );
  }
}

class _CenteredSpinner extends StatelessWidget {
  const _CenteredSpinner();

  @override
  Widget build(BuildContext context) {
    return const Padding(
      padding: EdgeInsets.symmetric(vertical: Insets.giant),
      child: Center(child: CircularProgressIndicator(strokeWidth: 3)),
    );
  }
}

class _ErrorState extends StatelessWidget {
  const _ErrorState({this.onRetry});

  final VoidCallback? onRetry;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.all(Insets.xxl),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(Icons.cloud_off_rounded,
              size: 40, color: context.colors.onSurfaceVariant),
          const SizedBox(height: Insets.md),
          Text('تعذّر عرض المحتوى', style: context.text.titleMedium),
          if (onRetry != null) ...[
            const SizedBox(height: Insets.md),
            OutlinedButton(onPressed: onRetry, child: const Text('إعادة المحاولة')),
          ],
        ],
      ),
    );
  }
}

/// Skeleton block used while lists load.
class SkeletonBox extends StatelessWidget {
  const SkeletonBox({super.key, this.height = 92, this.width});

  final double height;
  final double? width;

  @override
  Widget build(BuildContext context) {
    return Container(
      height: height,
      width: width ?? double.infinity,
      decoration: BoxDecoration(
        color: context.colors.surfaceContainer,
        borderRadius: Radii.brLg,
      ),
    );
  }
}
