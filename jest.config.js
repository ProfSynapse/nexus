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
    'src/services/embeddings/ContentChunker.ts',
    'src/services/embeddings/QAPairBuilder.ts',
    'src/services/embeddings/ConversationWindowRetriever.ts',
    'src/services/embeddings/ConversationEmbeddingWatcher.ts',
    'src/services/embeddings/ConversationEmbeddingService.ts',
    'src/services/embeddings/ConversationIndexer.ts',
    'src/services/embeddings/TraceIndexer.ts',
    'src/agents/searchManager/services/ConversationSearchStrategy.ts',
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
    },
    // Conversation memory search: pure functions (high bar)
    // ContentChunker: lines 114-115 are unreachable defensive code (line 128
    // preemptively catches the same case). Thresholds set below 100% accordingly.
    './src/services/embeddings/ContentChunker.ts': {
      branches: 85,
      functions: 100,
      lines: 93,
      statements: 93
    },
    './src/services/embeddings/QAPairBuilder.ts': {
      branches: 85,
      functions: 90,
      lines: 90,
      statements: 90
    },
    // Conversation memory search: classes with mocked dependencies
    './src/services/embeddings/ConversationWindowRetriever.ts': {
      branches: 85,
      functions: 100,
      lines: 90,
      statements: 90
    },
    './src/services/embeddings/ConversationEmbeddingWatcher.ts': {
      branches: 90,
      functions: 90,
      lines: 90,
      statements: 90
    },
    // Refactored embedding/search modules (F3-F4 review findings)
    './src/services/embeddings/ConversationEmbeddingService.ts': {
      branches: 75,
      functions: 85,
      lines: 80,
      statements: 80
    },
    './src/services/embeddings/ConversationIndexer.ts': {
      branches: 70,
      functions: 80,
      lines: 75,
      statements: 75
    },
    './src/services/embeddings/TraceIndexer.ts': {
      branches: 70,
      functions: 80,
      lines: 75,
      statements: 75
    },
    './src/agents/searchManager/services/ConversationSearchStrategy.ts': {
      branches: 80,
      functions: 85,
      lines: 85,
      statements: 85
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
