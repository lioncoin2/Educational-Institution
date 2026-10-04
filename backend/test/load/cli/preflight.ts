/**
 * P8.2 — preflight CLI. READ-ONLY: verifies an off-box generator can reach and
 * authenticate to staging, and prints a PASS/FAIL table. Generates no load.
 *
 *   npx ts-node test/load/cli/preflight.ts \
 *     --target https://api-staging.adlink4.com \
 *     --livekit-url wss://livekit-staging.adlink4.com
 *
 * LOADTEST_LIVEKIT_URL/_API_KEY/_API_SECRET (and optional LOADTEST_API_*) come
 * from the environment; they are never printed (redacted in the table).
 */
import { type PreflightInput, renderTable, runPreflight, summarize } from '../livekit/preflight';

function arg(argv: readonly string[], name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
}

export function buildInput(argv: readonly string[], env: NodeJS.ProcessEnv): PreflightInput {
  return {
    apiBase: arg(argv, 'target') ?? env.LOADTEST_API_BASE ?? null,
    livekitUrl: arg(argv, 'livekit-url') ?? env.LOADTEST_LIVEKIT_URL ?? null,
    env,
  };
}

export async function main(argv: readonly string[]): Promise<number> {
  const input = buildInput(argv, process.env);
  if (!input.livekitUrl && !input.apiBase) {
    process.stdout.write('Usage: preflight --target <https> --livekit-url <wss>\n');
    return 2;
  }
  const results = await runPreflight(input);
  process.stdout.write(`${renderTable(results)}\n`);
  return summarize(results).pass ? 0 : 1;
}

if (require.main === module) {
  void main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
