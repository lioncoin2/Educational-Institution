import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { PINNED_LIVEKIT_SERVER_VERSION } from '../../../src/platform/config/livekit-config';

/**
 * The pinned LiveKit server release (P7.1, decision 1): the version the
 * application refuses to run real media without, and the release archive
 * for this suite's platform with its sha256 — the digest in the release's
 * own checksums.txt. Moving the pin means recording the new release's digest
 * here; until then the suite refuses to run.
 */
export const PINNED_RELEASE: Readonly<{ version: string; asset: string; sha256: string }> = {
  version: '1.13.7',
  asset: 'livekit_1.13.7_linux_amd64.tar.gz',
  sha256: '6634aeeb2fb1366b6723708ae4320b9d5408106a4c63457c5e845ae3979c90e2',
};

/** Where the archive is published. */
export const RELEASE_URL = `https://github.com/livekit/livekit/releases/download/v${PINNED_RELEASE.version}/${PINNED_RELEASE.asset}`;

/**
 * The verified archive, kept between runs (gitignored; CI caches it by
 * version). Nothing extracted from it is trusted across runs.
 */
export const RELEASE_CACHE = join(
  __dirname,
  '..',
  '..',
  '..',
  '.cache',
  'livekit',
  PINNED_RELEASE.version,
);

/** What `livekit-server --version` prints for the pinned release. */
const VERSION_LINE = `livekit-server version ${PINNED_RELEASE.version}`;

/**
 * The pinned server binary, resolved without any developer action — and
 * never skipped: anything short of the pinned release throws.
 *
 *   1. LIVEKIT_SERVER_BINARY, a binary already on this machine;
 *   2. else the archive in RELEASE_CACHE, if its sha256 is the pinned one;
 *   3. else the archive downloaded from RELEASE_URL, verified, then cached.
 *
 * From an archive, the binary is extracted afresh on every run. Whatever
 * the source, the binary must report the pinned version.
 */
export async function pinnedServerBinary(env: NodeJS.ProcessEnv = process.env): Promise<string> {
  if (PINNED_RELEASE.version !== PINNED_LIVEKIT_SERVER_VERSION) {
    throw new Error(
      `The application pins LiveKit ${PINNED_LIVEKIT_SERVER_VERSION}, but this suite's release ` +
        `is ${PINNED_RELEASE.version}: record the pinned release's archive and sha256 in pinned-release.ts.`,
    );
  }
  const given = env.LIVEKIT_SERVER_BINARY?.trim() ?? '';
  const binary = given === '' ? await fromRelease() : given;
  let reported: string;
  try {
    reported = execFileSync(binary, ['--version'], { encoding: 'utf8', timeout: 10_000 }).trim();
  } catch (error) {
    throw new Error(`${binary} does not run as a LiveKit server: ${(error as Error).message}`);
  }
  if (reported !== VERSION_LINE) {
    throw new Error(`${binary} reports "${reported}", not the pinned "${VERSION_LINE}".`);
  }
  return binary;
}

async function fromRelease(): Promise<string> {
  if (process.platform !== 'linux' || process.arch !== 'x64') {
    throw new Error(
      `The pinned release is ${PINNED_RELEASE.asset}, for linux x64; on ${process.platform} ` +
        `${process.arch} set LIVEKIT_SERVER_BINARY to a livekit-server ${PINNED_RELEASE.version} binary.`,
    );
  }
  mkdirSync(RELEASE_CACHE, { recursive: true });
  const archive = join(RELEASE_CACHE, PINNED_RELEASE.asset);
  if (!existsSync(archive) || sha256(readFileSync(archive)) !== PINNED_RELEASE.sha256) {
    await download(archive);
  }
  execFileSync('tar', ['-xzf', archive, '--no-same-owner', '-C', RELEASE_CACHE, 'livekit-server']);
  return join(RELEASE_CACHE, 'livekit-server');
}

/** Downloads the archive and keeps it only if its sha256 is the pinned one. */
async function download(archive: string): Promise<void> {
  process.stdout.write(`Downloading the pinned LiveKit server release: ${RELEASE_URL}\n`);
  let response: Response;
  try {
    response = await fetch(RELEASE_URL, { signal: AbortSignal.timeout(300_000) });
  } catch (error) {
    throw new Error(
      `Could not download ${RELEASE_URL} (${(error as Error).message}); set LIVEKIT_SERVER_BINARY ` +
        `to a livekit-server ${PINNED_RELEASE.version} binary to run the suite offline.`,
    );
  }
  if (!response.ok) throw new Error(`Downloading ${RELEASE_URL} failed: HTTP ${response.status}.`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const digest = sha256(bytes);
  if (digest !== PINNED_RELEASE.sha256) {
    throw new Error(
      `${RELEASE_URL} has sha256 ${digest}, not the pinned ${PINNED_RELEASE.sha256}: refused.`,
    );
  }
  const partial = `${archive}.partial`;
  writeFileSync(partial, bytes);
  renameSync(partial, archive);
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}
