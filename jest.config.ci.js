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
  
  testPathIgnorePatterns: [
    '/node_modules/'
  ],
  
  // Better resource management
  workerIdleMemoryLimit: '512MB',
  detectOpenHandles: true,
  forceExit: true,
};