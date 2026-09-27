/**
 * The real LiveKit suite (P7.1): the application against the pinned LiveKit
 * server, driven by a real WebRTC client. global-setup.ts resolves the pinned
 * release (verified) and starts two servers from the committed policy file;
 * global-teardown.ts stops them. `npm test` never runs this directory and
 * this run needs nothing started by hand, so the suite is never skipped: it
 * runs, or it fails.
 */
const main = require('../../jest.config');

module.exports = {
  ...main,
  rootDir: '../..',
  roots: ['<rootDir>/test/livekit'],
  testPathIgnorePatterns: ['/node_modules/'],
  globalSetup: '<rootDir>/test/livekit/global-setup.ts',
  globalTeardown: '<rootDir>/test/livekit/global-teardown.ts',
  testTimeout: 30000,
};
