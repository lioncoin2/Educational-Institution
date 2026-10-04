/**
 * P8.3.6/P8.3.8/P8.4 — TEST-ONLY fake media driver implementing the driver port
 * (mp/driver.ts), plus a forkable entry that runs it through the REAL worker
 * lifecycle (`runWorkerProcess`). It replaces rtc-node and the network, nothing
 * else, so fleet and worker tests exercise the production lifecycle, media
 * observation and transport classification rather than a copy of them.
 *
 * Behaviour is chosen per participant by markers in its ticket token (set by the
 * test's injected ticket minting — the signal travels in the admit command):
 *   PUBFAIL  — publishing always fails (phase-A abort)
 *   HANG     — disconnect never resolves (teardown timeout / forced kill)
 *   SPAWN    — connect spawns a short-lived child process, as rtc-node's os_info
 *              crate does with `lsb_release -a` (process accounting)
 *   FAILCONN — connect throws
 *   NOSUB    — never receives TrackSubscribed
 *   STALL    — packets stop arriving ~1 s after connect
 *   RELAY    — a relay candidate is gathered and selected
 *   TCP      — the selected pair is TCP
 *   DUP      — evicted with DUPLICATE_IDENTITY ~1 s after connect
 *   LAG      — the first stats round blocks the worker's event loop once for
 *              LAG_SPIKE_MS (one real lag window above the G-lag RED edge)
 *
 * Not a *.spec file, so jest never runs it as a test.
 */
import { spawn } from 'node:child_process';

import {
  type Driver,
  type LoadParticipantLike,
  type MediaStatsSnapshot,
  type ParticipantEvent,
} from './driver';
import { type CandidateType } from './types';
import { runWorkerProcess } from './worker';

const PACKETS_PER_SECOND = 50;
const SAMPLE_RATE = 48_000;
const LAG_SPIKE_MS = 400;

function tone(durationMs: number): Int16Array {
  const out = new Int16Array(Math.round((SAMPLE_RATE * durationMs) / 1000));
  for (let i = 0; i < out.length; i += 1)
    out[i] = Math.round(4_000 * Math.sin((2 * Math.PI * 440 * i) / SAMPLE_RATE));
  return out;
}

export const fakeDriver: Driver = {
  LoadParticipant: {
    async connect(ticket, opts): Promise<LoadParticipantLike> {
      const has = (marker: string): boolean => ticket.token.includes(marker);
      if (has('FAILCONN')) throw new Error('fake connect failure');
      if (has('SPAWN')) spawn('sleep', ['0.3'], { stdio: 'ignore' }).unref();
      const connectedAt = Date.now();
      const relay = opts.ice.mode === 'relay' || has('RELAY');
      const timers: Array<ReturnType<typeof setTimeout>> = [];
      let listener: (e: ParticipantEvent) => void = () => undefined;
      const later = (ms: number, e: ParticipantEvent): void => {
        timers.push(setTimeout(() => listener(e), ms));
      };
      const publish = async (): Promise<void> => {
        if (has('PUBFAIL')) throw new Error('fake publish failure');
      };
      const packets = (): number => {
        const elapsed = Date.now() - connectedAt;
        const flowing = has('STALL') ? Math.min(elapsed, 1_000) : elapsed;
        return Math.floor((flowing * PACKETS_PER_SECOND) / 1000);
      };
      const localType: CandidateType = relay ? 'relay' : 'host';
      let lagged = false;
      return {
        publishMicrophone: async () => {
          await publish();
          return { trackSid: 'TR_fake_audio' };
        },
        publishScreenShare: publish,
        disconnect: () => {
          for (const t of timers) clearTimeout(t);
          return has('HANG') ? new Promise<void>(() => undefined) : Promise.resolve();
        },
        onEvent: (l) => {
          listener = l;
          if (opts.subscribe && !has('NOSUB'))
            later(20, {
              kind: 'trackSubscribed',
              trackSid: 'TR_fake_audio',
              publisher: 'fake-pub',
            });
          if (has('DUP')) later(1_000, { kind: 'disconnected', reason: 'DUPLICATE_IDENTITY' });
        },
        stats: async (): Promise<MediaStatsSnapshot> => {
          if (has('LAG') && !lagged) {
            lagged = true;
            const until = Date.now() + LAG_SPIKE_MS;
            while (Date.now() < until); // a synchronous stall, as a large getRtcStats decode is
          }
          return snapshot();
        },
        captureAudio: async (ms) =>
          opts.subscribe ? { samples: tone(ms), sampleRate: SAMPLE_RATE } : null,
      };
      function snapshot(): MediaStatsSnapshot {
        return {
          statsTsMs: Date.now(),
          inbound: opts.subscribe
            ? { packetsReceived: packets(), packetsLost: 0, jitterSec: 0.002 }
            : null,
          outbound: opts.subscribe ? null : { packetsSent: packets() },
          selectedPair: {
            protocol: has('TCP') ? 'tcp' : 'udp',
            localType,
            remoteType: relay ? 'relay' : 'host',
            remotePort: relay ? 3478 : 7882,
            lastPacketReceivedMs: null,
          },
          localCandidateTypes: relay ? ['host', 'relay'] : ['host'],
        };
      }
    },
  },
  disposeMedia: async () => undefined,
};

if (require.main === module) {
  runWorkerProcess(async () => fakeDriver);
}
