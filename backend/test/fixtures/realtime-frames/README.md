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
