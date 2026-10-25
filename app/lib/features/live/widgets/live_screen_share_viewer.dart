import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/theme/app_tokens.dart';
import '../../../core/theme/live_palette.dart';
import '../../../data/media/livekit/livekit_screen_share_view.dart';
import '../../../data/models/live_media.dart';
import '../live_copy.dart';
import '../state/live_media_controller.dart';

/// Opens the shared screen of [identity] full-screen, above the live room — a
/// pushed route, so closing it returns to the room with the session (and the
/// media connection) untouched.
Future<void> openLiveScreenShareViewer(BuildContext context, String identity) =>
    Navigator.of(context, rootNavigator: true).push(
      MaterialPageRoute<void>(
        fullscreenDialog: true,
        builder: (_) => LiveScreenShareViewer(identity: identity),
      ),
    );

/// The shared screen at full size: the picture uses the whole viewport at its
/// own aspect ratio (letterboxed, never cropped — the renderer's `contain`),
/// in portrait or landscape, pinch-to-zoom up to [maxZoom] and a double tap to
/// toggle zoom, with the close button always reachable. It follows the media
/// seam's live view: when [identity] stops sharing, it closes itself.
class LiveScreenShareViewer extends ConsumerStatefulWidget {
  const LiveScreenShareViewer({super.key, required this.identity});

  final String identity;

  static const maxZoom = 5.0;
  static const _doubleTapZoom = 2.5;

  @override
  ConsumerState<LiveScreenShareViewer> createState() =>
      _LiveScreenShareViewerState();
}

class _LiveScreenShareViewerState extends ConsumerState<LiveScreenShareViewer> {
  final _zoom = TransformationController();
  TapDownDetails? _doubleTap;
  bool _closing = false;

  @override
  void dispose() {
    _zoom.dispose();
    super.dispose();
  }

  void _close() {
    if (_closing) return;
    _closing = true;
    Navigator.of(context).maybePop();
  }

  void _toggleZoom() {
    if (_zoom.value.getMaxScaleOnAxis() > 1.01) {
      _zoom.value = Matrix4.identity();
      return;
    }
    final at = _doubleTap?.localPosition ?? Offset.zero;
    const scale = LiveScreenShareViewer._doubleTapZoom;
    _zoom.value = Matrix4.identity()
      ..translateByDouble(-at.dx * (scale - 1), -at.dy * (scale - 1), 0, 1)
      ..scaleByDouble(scale, scale, 1, 1);
  }

  @override
  Widget build(BuildContext context) {
    final remotes = ref.watch(liveRemoteParticipantsProvider).asData?.value;
    final LiveRemoteParticipant? sharing = remotes?.values
        .where((r) => r.identity == widget.identity && r.screenSharing)
        .firstOrNull;
    if (remotes != null && sharing == null) {
      // The share ended (or its sharer left): back to the room.
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (mounted) _close();
      });
    }

    return Theme(
      data: LivePalette.themeOf(context),
      child: Scaffold(
        key: const Key('live-screen-fullscreen'),
        backgroundColor: Colors.black,
        body: Stack(
          fit: StackFit.expand,
          children: [
            GestureDetector(
              onDoubleTapDown: (details) => _doubleTap = details,
              onDoubleTap: _toggleZoom,
              child: InteractiveViewer(
                key: const Key('live-screen-zoom'),
                transformationController: _zoom,
                minScale: 1,
                maxScale: LiveScreenShareViewer.maxZoom,
                child: SizedBox.expand(
                  child: LiveKitScreenShareView(
                    key: ValueKey('fullscreen-${widget.identity}'),
                    track: sharing?.screenShareTrack,
                  ),
                ),
              ),
            ),
            SafeArea(
              child: Align(
                alignment: AlignmentDirectional.topStart,
                child: Padding(
                  padding: const EdgeInsets.all(Insets.sm),
                  child: IconButton.filledTonal(
                    key: const Key('live-screen-close'),
                    tooltip: LiveCopy.liveScreenClose,
                    onPressed: _close,
                    icon: const Icon(Icons.fullscreen_exit_rounded),
                  ),
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}
