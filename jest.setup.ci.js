// Setup file for CI to reduce console noise
const originalConsoleLog = console.log;
const originalConsoleInfo = console.info;
const originalConsoleWarn = console.warn;

// Track current test for better output
let currentTestName = '';

beforeEach(() => {
  // Get current test name
  const testName = expect.getState().currentTestName;
  if (testName && testName !== currentTestName) {
    currentTestName = testName;
    originalConsoleLog(`Running test: ${testName}`);
  }
});

afterEach(() => {
  // Test completed message is handled by Jest's default reporter
});

// Override console methods to reduce noise
console.log = (...args) => {
  // Only show important logs (errors, specific test progress)
  const message = args.join(' ');
  if (
    message.includes('ERROR') ||
    message.includes('FAIL') ||
    message.includes('starting test:') ||
    message.includes('Creating scratch org:') ||
    message.includes('Test Org') ||
    message.includes('migration completed') ||
    message.includes('::group::') ||
    message.includes('::endgroup::')
  ) {
    originalConsoleLog(...args);
  }
};

console.info = (...args) => {
  // Suppress most info logs
  const message = args.join(' ');
  if (message.includes('ERROR') || message.includes('FAIL')) {
    originalConsoleInfo(...args);
  }
};

console.warn = (...args) => {
  // Keep warnings
  originalConsoleWarn(...args);
};