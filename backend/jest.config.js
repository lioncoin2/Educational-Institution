/** Unit + architecture tests. No database, no network: every port has a fake. */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/src', '<rootDir>/test'],
  testRegex: '.*\\.spec\\.ts$',
  // The real LiveKit suite is its own run (`npm run test:livekit`, with its
  // own config): excluded here, never skipped.
  testPathIgnorePatterns: ['/node_modules/', '<rootDir>/test/livekit/'],
  moduleNameMapper: {
    '^@shared/(.*)$': '<rootDir>/src/shared/$1',
    '^@platform/(.*)$': '<rootDir>/src/platform/$1',
    '^@modules/(.*)$': '<rootDir>/src/modules/$1',
  },
  collectCoverageFrom: ['src/**/*.ts', '!src/**/*.spec.ts', '!src/main.ts'],
  testTimeout: 20000,
};
