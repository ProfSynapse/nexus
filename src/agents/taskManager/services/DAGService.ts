/**
 * Location: src/agents/taskManager/services/DAGService.ts
 * Purpose: Pure computation service for DAG (Directed Acyclic Graph) operations on task dependencies.
 * No storage access — takes data in, returns results. Maximally testable.
 *
 * Used by: TaskService (for cycle validation, dependency queries, topological ordering)
 */

import {
  Edge,
  TaskNode,
  IDAGService
} from '../types';

export class DAGService implements IDAGService {

  /**
   * Check whether adding an edge (taskId -> dependsOnTaskId) would create a cycle.
   * Returns true if NO cycle would be created (safe to add).
   * Returns false if a cycle WOULD be created (reject the edge).
   *
   * Uses DFS from dependsOnTaskId to see if we can reach taskId through existing edges.
   */
  validateNoCycle(taskId: string, dependsOnTaskId: string, allEdges: Edge[]): boolean {
    // Self-dependency is always a cycle
    if (taskId === dependsOnTaskId) {
      return false;
    }

    // Build adjacency list: for each task, which tasks does it depend on?
    const adjacency = new Map<string, string[]>();
    for (const edge of allEdges) {
      const deps = adjacency.get(edge.taskId);
      if (deps) {
        deps.push(edge.dependsOnTaskId);
      } else {
        adjacency.set(edge.taskId, [edge.dependsOnTaskId]);
      }
    }

    // DFS from dependsOnTaskId following edges backwards (upstream).
    // If we reach taskId, adding the edge would create a cycle.
    // We check: can dependsOnTaskId reach taskId through its own dependencies?
    const visited = new Set<string>();
    const stack = [dependsOnTaskId];

    while (stack.length > 0) {
      const current = stack.pop();
      if (!current) {
        continue;
      }

      if (current === taskId) {
        return false; // Cycle detected
      }
      if (visited.has(current)) {
        continue;
      }
      visited.add(current);

      const neighbors = adjacency.get(current);
      if (neighbors) {
        for (const neighbor of neighbors) {
          if (!visited.has(neighbor)) {
            stack.push(neighbor);
          }
        }
      }
    }

    return true; // No cycle
  }

  /**
   * Topological sort using Kahn's algorithm.
   * Returns tasks ordered so that dependencies come before dependents.
   * Tasks not involved in any edges are included at the beginning.
   */
  topologicalSort(tasks: TaskNode[], edges: Edge[]): TaskNode[] {
    const taskMap = new Map<string, TaskNode>();
    for (const task of tasks) {
      taskMap.set(task.id, task);
    }

    // Build in-degree map and adjacency (dependsOn -> dependents)
    const inDegree = new Map<string, number>();
    const dependents = new Map<string, string[]>();

    for (const task of tasks) {
      inDegree.set(task.id, 0);
    }

    for (const edge of edges) {
      // edge.taskId depends on edge.dependsOnTaskId
      // So dependsOnTaskId -> taskId in the graph
      const current = inDegree.get(edge.taskId) ?? 0;
      inDegree.set(edge.taskId, current + 1);

      const deps = dependents.get(edge.dependsOnTaskId);
      if (deps) {
        deps.push(edge.taskId);
      } else {
        dependents.set(edge.dependsOnTaskId, [edge.taskId]);
      }
    }

    // Start with tasks that have no incoming edges (no dependencies)
    const queue: string[] = [];
    for (const [id, degree] of inDegree) {
      if (degree === 0) {
        queue.push(id);
      }
    }

    const sorted: TaskNode[] = [];
    while (queue.length > 0) {
      const id = queue.shift();
      if (!id) {
        continue;
      }

      const task = taskMap.get(id);
      if (task) {
        sorted.push(task);
      }

      const deps = dependents.get(id);
      if (deps) {
        for (const depId of deps) {
          const degree = (inDegree.get(depId) ?? 1) - 1;
          inDegree.set(depId, degree);
          if (degree === 0) {
            queue.push(depId);
          }
        }
      }
    }

    return sorted;
  }

  /**
   * Get tasks that are ready to work on: status is 'todo' and all dependencies are
   * either 'done' or 'cancelled'.
   */
  getNextActions(tasks: TaskNode[], edges: Edge[]): TaskNode[] {
    // Build set of incomplete dependency targets per task
    const taskStatusMap = new Map<string, TaskNode>();
    for (const task of tasks) {
      taskStatusMap.set(task.id, task);
    }

    // For each task, collect its incomplete dependencies
    const incompleteDeps = new Map<string, Set<string>>();
    for (const edge of edges) {
      const depTask = taskStatusMap.get(edge.dependsOnTaskId);
      if (depTask && depTask.status !== 'done' && depTask.status !== 'cancelled') {
        const deps = incompleteDeps.get(edge.taskId);
        if (deps) {
          deps.add(edge.dependsOnTaskId);
        } else {
          incompleteDeps.set(edge.taskId, new Set([edge.dependsOnTaskId]));
        }
      }
    }

    return tasks.filter(task => {
      if (task.status !== 'todo') return false;
      const deps = incompleteDeps.get(task.id);
      return !deps || deps.size === 0;
    });
  }

  /**
   * Get tasks that are blocked: status is 'todo' or 'in_progress' and at least
   * one dependency is not 'done' or 'cancelled'.
   */
  getBlockedTasks(tasks: TaskNode[], edges: Edge[]): TaskNode[] {
    const taskStatusMap = new Map<string, TaskNode>();
    for (const task of tasks) {
      taskStatusMap.set(task.id, task);
    }

    const blockedIds = new Set<string>();
    for (const edge of edges) {
      const depTask = taskStatusMap.get(edge.dependsOnTaskId);
      if (depTask && depTask.status !== 'done' && depTask.status !== 'cancelled') {
        const task = taskStatusMap.get(edge.taskId);
        if (task && (task.status === 'todo' || task.status === 'in_progress')) {
          blockedIds.add(edge.taskId);
        }
      }
    }

    return tasks.filter(task => blockedIds.has(task.id));
  }

  /**
   * Get the dependency tree for a given task: which tasks it depends on (upstream)
   * and which tasks depend on it (downstream).
   *
   * Returns flat lists of IDs for each direction — TaskService maps these to full metadata.
   */
  getDependencyTree(
    rootTaskId: string,
    tasks: TaskNode[],
    edges: Edge[]
  ): { dependencies: string[]; dependents: string[] } {
    // Build adjacency lists
    const depsOf = new Map<string, string[]>();     // task -> tasks it depends on
    const dependentsOf = new Map<string, string[]>(); // task -> tasks depending on it

    for (const edge of edges) {
      const deps = depsOf.get(edge.taskId);
      if (deps) {
        deps.push(edge.dependsOnTaskId);
      } else {
        depsOf.set(edge.taskId, [edge.dependsOnTaskId]);
      }

      const revDeps = dependentsOf.get(edge.dependsOnTaskId);
      if (revDeps) {
        revDeps.push(edge.taskId);
      } else {
        dependentsOf.set(edge.dependsOnTaskId, [edge.taskId]);
      }
    }

    // Traverse upstream (dependencies)
    const dependencies = this.collectTransitive(rootTaskId, depsOf);

    // Traverse downstream (dependents)
    const dependents = this.collectTransitive(rootTaskId, dependentsOf);

    return { dependencies, dependents };
  }

  /**
   * Collect all transitively reachable nodes from startId via adjacency map.
   */
  private collectTransitive(startId: string, adjacency: Map<string, string[]>): string[] {
    const visited = new Set<string>();
    const stack = adjacency.get(startId) ?? [];
    const result: string[] = [];

    const toVisit = [...stack];
    while (toVisit.length > 0) {
      const current = toVisit.pop();
      if (!current) {
        continue;
      }

      if (visited.has(current)) continue;
      visited.add(current);
      result.push(current);

      const neighbors = adjacency.get(current);
      if (neighbors) {
        for (const neighbor of neighbors) {
          if (!visited.has(neighbor)) {
            toVisit.push(neighbor);
          }
        }
      }
    }

    return result;
  }
}
