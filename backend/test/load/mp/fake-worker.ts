/**
 * P8.3.6/P8.3.8 — TEST-ONLY fake media driver, plus a forkable entry that runs
 * it through the REAL worker lifecycle (`runWorkerProcess` from worker.ts). It
 * replaces rtc-node and the network, nothing else, so the supervisor and worker
 * tests exercise the production lifecycle code rather than a copy of it.
 *
 * Behaviour is chosen per participant by markers in its ticket token (set by the
 * test's injected ticket minting — the signal travels in the assignment):
 *   PUBFAIL — publishing always fails (phase-A abort)
 *   HANG    — disconnect never resolves (teardown timeout / forced kill)
 *   SPAWN   — connect spawns a short-lived child process, as rtc-node's os_info
 *             crate does with `lsb_release -a` (process accounting)
 *
 * Not a *.spec file, so jest never runs it as a test.
 */
import { spawn } from 'node:child_process';

import { type Driver, type LoadParticipantLike, runWorkerProcess } from './worker';

export const fakeDriver: Driver = {
  LoadParticipant: {
    async connect(ticket): Promise<LoadParticipantLike> {
      const has = (marker: string): boolean => ticket.token.includes(marker);
      if (has('SPAWN')) spawn('sleep', ['0.3'], { stdio: 'ignore' }).unref();
      const publish = async (): Promise<void> => {
        if (has('PUBFAIL')) throw new Error('fake publish failure');
      };
      return {
        publishMicrophone: publish,
        publishScreenShare: publish,
        disconnect: () => (has('HANG') ? new Promise<void>(() => undefined) : Promise.resolve()),
      };
    },
  },
  disposeMedia: async () => undefined,
};

if (require.main === module) {
  runWorkerProcess(async () => fakeDriver);
}
