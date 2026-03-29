/**
 * Location: src/database/repositories/index.ts
 *
 * Repository Module Exports
 *
 * Central export point for all repository classes and interfaces.
 * Simplifies imports throughout the application.
 *
 * Usage:
 * ```typescript
 * import {
 *   WorkspaceRepository,
 *   SessionRepository,
 *   IWorkspaceRepository
 * } from '@/database/repositories';
 * ```
 */

// Base repository and dependencies
export { BaseRepository } from './base/BaseRepository';
export type { RepositoryDependencies } from './base/BaseRepository';

// Repository interfaces
export type { IRepository } from './interfaces/IRepository';
export type {
  IWorkspaceRepository,
  CreateWorkspaceData,
  UpdateWorkspaceData
} from './interfaces/IWorkspaceRepository';
export type {
  ISessionRepository,
  CreateSessionData,
  UpdateSessionData
} from './interfaces/ISessionRepository';
export type {
  IStateRepository,
  SaveStateData
} from './interfaces/IStateRepository';
export type {
  ITraceRepository,
  AddTraceData
} from './interfaces/ITraceRepository';

// Repository implementations
export { WorkspaceRepository } from './WorkspaceRepository';
export { SessionRepository } from './SessionRepository';
export { StateRepository } from './StateRepository';
export { TraceRepository } from './TraceRepository';
export { ProjectRepository } from './ProjectRepository';
export { TaskRepository } from './TaskRepository';

// Task management interfaces
export type {
  IProjectRepository,
  ProjectMetadata,
  CreateProjectData,
  UpdateProjectData
} from './interfaces/IProjectRepository';
export type {
  ITaskRepository,
  TaskMetadata,
  CreateTaskData,
  UpdateTaskData,
  NoteLink,
  TaskStatus,
  TaskPriority,
  LinkType,
  TaskListOptions
} from './interfaces/ITaskRepository';
