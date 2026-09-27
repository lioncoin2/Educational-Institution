# Realtime frame fixtures

Golden JSON for the protocol v1 server frames that P5 added
(docs/architecture/realtime.md). Two sides read the same files:

- the backend's frame builders (`src/modules/realtime/application/envelopes.ts`)
  must produce exactly these objects from the inputs their spec names;
- the Flutter parser (`app/lib/data/realtime/realtime_frames.dart`) must
  parse every one of them (`app/test/realtime/`).

A field that changes here changes on both sides at once, or one of the two
test suites fails. Frames carry ids, codes and versions only: never a name,
a title, a count, a token or a roster.

## `live/` — read by the backend only, for now

The three Live frames P6 added (`live.session.started`, `live.session.ended`,
one file per end reason, and `live.session.changed`) sit in `live/`, and only
the backend reads them: `envelopes.spec.ts` asserts that each builder produces
exactly its file. The app's fixture test lists this directory's files and not
its subdirectories, and P6 changes nothing in the app, which ignores a frame
type it does not know. The Flutter live phase moves these files beside the
others when it adds their parser (the P6 audit, D16). The same rule holds for
them: ids, codes and versions only — never a name, a count, a roster or a
join credential.
