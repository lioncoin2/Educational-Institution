# backend/test/load — P8 load-generation harness

Dry-run by default; generates **no** load without `--allow-load` + `--target` within the safety caps.

```bash
cd backend
npx ts-node test/load/cli/run.ts --list
npx ts-node test/load/cli/run.ts --scenario lk-listeners-3000      # dry-run, no load
npx jest test/load                                                 # unit tests
```

Full design, safety model, real-run enablement, scenarios and off-box requirements:
**`docs/p8.1-load-harness.md`**.

Layout: `core/` (config, safety, identity) · `scenarios/` (catalog) · `metrics/` (parsers + collector) ·
`livekit/` (SFU-direct tokens + media orchestration) · `api/` (API/WS load) · `cli/` (entry) · `tests/`.

The only file that imports `@livekit/rtc-node` is `test/livekit/load/media-driver.ts` (kept there for the
architecture test); the harness reaches it by dynamic import on real runs only.
