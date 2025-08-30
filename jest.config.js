module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx', 'json', 'node'],
  // Better output for CI/CD
  verbose: true,
  reporters: [
    'default'
  ],
  // Show individual test results as they complete
  testTimeout: 120000, // 2 minutes per test (for e2e tests)
};
