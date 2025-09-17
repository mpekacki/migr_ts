module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx', 'json', 'node'],
  
  // Minimal output for CI
  verbose: false,
  silent: false,
  
  // Custom reporter for clean CI output
  reporters: [
    ['default', {
      silent: false,
      useCoverageReporter: false,
      summaryThreshold: 0 // Don't show summary for individual test suites
    }]
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
  
  // Reduce console output from tests
  setupFilesAfterEnv: ['<rootDir>/jest.setup.ci.js']
};