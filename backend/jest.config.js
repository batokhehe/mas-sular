/** @type {import('jest').Config} */
module.exports = {
  moduleFileExtensions: ['js', 'json', 'ts'],
  rootDir: '.',
  testMatch: ['<rootDir>/test/**/*.spec.ts'],
  transform: {
    '^.+\\.(t|j)s$': 'ts-jest',
  },
  testEnvironment: 'node',
  // Refuses fetch to any real host, so no unit test can book with a courier by accident.
  setupFiles: ['<rootDir>/test/setup/no-external-network.ts'],
};
