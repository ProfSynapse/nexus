/**
 * Jest Setup File
 *
 * Runs before each test file to configure the testing environment.
 */

// Extend Jest timeout for async operations
jest.setTimeout(10000);

// Mock console.error to reduce noise in tests (but still capture for assertions)
const originalConsoleError = console.error;
beforeAll(() => {
  console.error = jest.fn((...args) => {
    // Still log to help debug failing tests
    if (process.env.DEBUG_TESTS) {
      originalConsoleError(...args);
    }
  });
});

afterAll(() => {
  console.error = originalConsoleError;
});

// Clear all mocks between tests
beforeEach(() => {
  jest.clearAllMocks();
});
