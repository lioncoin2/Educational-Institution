import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/theme/app_tokens.dart';
import '../../../data/models/academic.dart';
import '../../../providers/app_providers.dart';
import '../community_copy.dart';

/// Lets an authorized manager choose an academic halaqa to link a community to
/// (Q50), by browsing the existing academic catalogue — sections → programs →
/// halaqat. It shows structure only; the catalogue carries no student and no
/// teacher. Returns the chosen halaqa, or null when dismissed. The selection is
/// not the authorization: the server validates the halaqa again and decides on
/// `communities.manage` when the link is sent.
Future<AcademicHalaqa?> showHalaqaPicker(BuildContext context) {
  return showModalBottomSheet<AcademicHalaqa>(
    context: context,
    isScrollControlled: true,
    showDragHandle: true,
    builder: (_) => const _HalaqaPicker(),
  );
}

class _HalaqaPicker extends ConsumerStatefulWidget {
  const _HalaqaPicker();

  @override
  ConsumerState<_HalaqaPicker> createState() => _HalaqaPickerState();
}

class _HalaqaPickerState extends ConsumerState<_HalaqaPicker> {
  late Future<List<AcademicSection>> _catalogue;

  @override
  void initState() {
    super.initState();
    _catalogue = ref.read(academicRepositoryProvider).catalogue();
  }

  void _reload() {
    setState(() {
      _catalogue = ref.read(academicRepositoryProvider).catalogue();
    });
  }

  @override
  Widget build(BuildContext context) {
    return SafeArea(
      child: ConstrainedBox(
        constraints: BoxConstraints(
          maxHeight: MediaQuery.of(context).size.height * 0.8,
        ),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Padding(
              padding: const EdgeInsets.all(Insets.lg),
              child: Text(
                CommunityCopy.halaqaPickerTitle,
                style: Theme.of(context).textTheme.titleMedium,
              ),
            ),
            Flexible(
              child: FutureBuilder<List<AcademicSection>>(
                future: _catalogue,
                builder: (context, snapshot) {
                  if (snapshot.connectionState != ConnectionState.done) {
                    return const Padding(
                      padding: EdgeInsets.all(Insets.xl),
                      child: Center(child: CircularProgressIndicator()),
                    );
                  }
                  if (snapshot.hasError) {
                    return _PickerMessage(
                      message: CommunityCopy.halaqaPickerError,
                      onRetry: _reload,
                    );
                  }
                  final sections = [
                    for (final s in snapshot.data ?? const <AcademicSection>[])
                      if (s.isActive && s.programs.any((p) => p.isActive)) s,
                  ];
                  if (sections.isEmpty) {
                    return const _PickerMessage(
                      message: CommunityCopy.halaqaPickerEmpty,
                    );
                  }
                  return ListView(
                    shrinkWrap: true,
                    children: [
                      for (final section in sections) ...[
                        Padding(
                          padding: const EdgeInsets.symmetric(
                            horizontal: Insets.lg,
                            vertical: Insets.sm,
                          ),
                          child: Text(
                            section.name,
                            style: Theme.of(context).textTheme.labelLarge,
                          ),
                        ),
                        for (final program in section.programs)
                          if (program.isActive)
                            _ProgramTile(program: program),
                      ],
                    ],
                  );
                },
              ),
            ),
          ],
        ),
      ),
    );
  }
}

/// A program, expandable to its halaqat — loaded only when opened, so the
/// picker fetches a program's halaqat once the manager looks inside it.
class _ProgramTile extends StatelessWidget {
  const _ProgramTile({required this.program});

  final AcademicProgram program;

  @override
  Widget build(BuildContext context) {
    return ExpansionTile(
      title: Text(program.name),
      children: [_ProgramHalaqat(programId: program.id)],
    );
  }
}

class _ProgramHalaqat extends ConsumerStatefulWidget {
  const _ProgramHalaqat({required this.programId});

  final String programId;

  @override
  ConsumerState<_ProgramHalaqat> createState() => _ProgramHalaqatState();
}

class _ProgramHalaqatState extends ConsumerState<_ProgramHalaqat> {
  late Future<AcademicProgramDetail?> _detail;

  @override
  void initState() {
    super.initState();
    _detail = ref.read(academicRepositoryProvider).program(widget.programId);
  }

  void _reload() {
    setState(() {
      _detail = ref.read(academicRepositoryProvider).program(widget.programId);
    });
  }

  @override
  Widget build(BuildContext context) {
    return FutureBuilder<AcademicProgramDetail?>(
      future: _detail,
      builder: (context, snapshot) {
        if (snapshot.connectionState != ConnectionState.done) {
          return const Padding(
            padding: EdgeInsets.all(Insets.md),
            child: Center(
              child: SizedBox.square(
                dimension: 18,
                child: CircularProgressIndicator(strokeWidth: 2),
              ),
            ),
          );
        }
        if (snapshot.hasError) {
          return _PickerMessage(
            message: CommunityCopy.halaqaPickerError,
            onRetry: _reload,
          );
        }
        final halaqat = snapshot.data?.halaqat ?? const <AcademicHalaqa>[];
        if (halaqat.isEmpty) {
          return const Padding(
            padding: EdgeInsets.all(Insets.md),
            child: Text(CommunityCopy.halaqaPickerEmpty),
          );
        }
        return Column(
          children: [
            for (final halaqa in halaqat)
              ListTile(
                title: Text(halaqa.name),
                onTap: () => Navigator.of(context).pop(halaqa),
              ),
          ],
        );
      },
    );
  }
}

class _PickerMessage extends StatelessWidget {
  const _PickerMessage({required this.message, this.onRetry});

  final String message;
  final VoidCallback? onRetry;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.all(Insets.xl),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          Text(message, textAlign: TextAlign.center),
          if (onRetry != null) ...[
            const SizedBox(height: Insets.md),
            TextButton(onPressed: onRetry, child: const Text(CommunityCopy.retry)),
          ],
        ],
      ),
    );
  }
}
