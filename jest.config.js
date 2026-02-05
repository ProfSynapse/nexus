/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/tests'],
  testMatch: ['**/*.test.ts'],
  moduleNameMapper: {
    '^obsidian$': '<rootDir>/tests/mocks/obsidian.ts',
    '^@/(.*)$': '<rootDir>/src/$1'
  },
  moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx', 'json', 'node'],
  collectCoverageFrom: [
    'src/services/InlineEditService.ts',
    'src/ui/chat/utils/toolCallUtils.ts',
    'src/ui/chat/utils/AbortHandler.ts',
    'src/ui/chat/services/MessageAlternativeService.ts',
    'src/ui/chat/services/BranchManager.ts',
    'src/ui/chat/components/MessageBranchNavigator.ts',
    'src/ui/chat/components/MessageDisplay.ts',
    '!src/**/*.d.ts'
  ],
  coverageThreshold: {
    // Per-file thresholds for pure logic files (high bar)
    './src/services/InlineEditService.ts': {
      branches: 80,
      functions: 80,
      lines: 80,
      statements: 80
    },
    './src/ui/chat/utils/toolCallUtils.ts': {
      branches: 100,
      functions: 100,
      lines: 100,
      statements: 100
    },
    './src/ui/chat/utils/AbortHandler.ts': {
      branches: 90,
      functions: 90,
      lines: 90,
      statements: 90
    },
    './src/ui/chat/services/MessageAlternativeService.ts': {
      branches: 70,
      functions: 80,
      lines: 80,
      statements: 80
    },
    // DOM-heavy components get lower thresholds (tested via lightweight mocks)
    './src/ui/chat/services/BranchManager.ts': {
      branches: 60,
      functions: 50,
      lines: 60,
      statements: 60
    },
    './src/ui/chat/components/MessageBranchNavigator.ts': {
      branches: 50,
      functions: 60,
      lines: 70,
      statements: 70
    },
    './src/ui/chat/components/MessageDisplay.ts': {
      branches: 15,
      functions: 25,
      lines: 40,
      statements: 40
    }
  },
  coverageDirectory: 'coverage',
  verbose: true,
  // Transform TypeScript files with ts-jest
  transform: {
    '^.+\\.tsx?$': ['ts-jest', {
      tsconfig: {
        // Override for tests - use CommonJS for Jest
        module: 'commonjs',
        target: 'ES2020',
        esModuleInterop: true,
        allowSyntheticDefaultImports: true,
        strict: true,
        skipLibCheck: true,
        moduleResolution: 'node'
      }
    }]
  },
  // Ignore node_modules except for specific ESM packages if needed
  transformIgnorePatterns: [
    'node_modules/(?!(@modelcontextprotocol)/)'
  ],
  // Setup files to run before tests
  setupFilesAfterEnv: ['<rootDir>/tests/setup.ts']
};
