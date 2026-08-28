module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx', 'json', 'node'],
  
  // List each test with its pass/fail status as suites complete
  verbose: true,
  // Discard console output from test code so CI logs stay clean
  silent: true,

  reporters: [
    'default',
    'github-actions' // PR annotations for failures + collapsible log groups
  ],
  
  testTimeout: 120000, // 2 minutes per test (for e2e tests)
  maxWorkers: 3,
  
  // e2e.test.ts and e2e-error-injection.test.ts are the two suites that reach a
  // real org; MIGR_TS_TEST_NO_ORGS drops them for a run that has none (a pull
  // request from a fork gets no Dev Hub credentials). e2e-mock.test.ts covers the
  // same scenarios in-process, so it stays in.
  testPathIgnorePatterns: [
    '/node_modules/',
    ...(process.env.MIGR_TS_TEST_NO_ORGS
      ? ['e2e\\.test\\.ts$', 'e2e-error-injection\\.test\\.ts$']
      : [])
  ],
  
  // Better resource management
  workerIdleMemoryLimit: '512MB',
  detectOpenHandles: true,
  forceExit: true,
};