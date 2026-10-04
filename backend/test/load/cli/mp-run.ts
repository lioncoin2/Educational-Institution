/**
 * RETIRED (P8.4). The P8.3 single-host multi-process runner and its supervisor
 * were replaced by the off-box fleet (controller + agents): one orchestration
 * path, run with test/load/cli/fleet-run.ts. This stub remains only because
 * the `load:mp` script in backend/package.json (outside the P8.4 change scope)
 * still names this file; it refuses to run and points at the replacement.
 */
if (require.main === module) {
  process.stderr.write(
    'cli/mp-run.ts is retired (P8.4). Use: npx ts-node test/load/cli/fleet-run.ts --help\n',
  );
  process.exitCode = 2;
}
