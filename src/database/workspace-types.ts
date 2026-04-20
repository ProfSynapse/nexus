/**
 * Legacy Workspace Types File - Refactored for Modular Organization
 * 
 * This file now re-exports all types from the organized modular structure.
 * The original workspace-types.ts file has been broken down into domain-specific modules:
 * 
 * - src/database/types/workspace/: Core workspace types and parameter definitions
 * - src/database/types/session/: Session tracking and state types
 * - src/database/types/memory/: Memory traces and file search types
 * - src/database/types/cache/: Cache management types
 * 
 * This approach follows SOLID principles:
 * - Single Responsibility: Each module handles one domain
 * - Open/Closed: Easy to extend without modifying existing code
 * - Interface Segregation: Clients depend only on what they use
 * - Dependency Inversion: Modules depend on abstractions
 */

// Re-export all types from the modular structure for backward compatibility
export * from './types';