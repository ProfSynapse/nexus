/**
 * DAGService Unit Tests
 *
 * Tests the pure computation service for DAG (Directed Acyclic Graph) operations
 * on task dependencies. No mocks needed — pure function testing.
 *
 * Coverage target: 95%+ (pure computation, high risk)
 */

import { DAGService } from '../../src/agents/taskManager/services/DAGService';
import { Edge, TaskNode, TaskStatus } from '../../src/agents/taskManager/types';

// ============================================================================
// Fixture Factories
// ============================================================================

function makeNode(id: string, status: TaskStatus = 'todo'): TaskNode {
  return { id, status };
}

function makeEdge(taskId: string, dependsOnTaskId: string): Edge {
  return { taskId, dependsOnTaskId };
}

/**
 * Creates a linear chain: A -> B -> C -> ... -> N
 * Where each task depends on the previous one.
 */
function createLinearChain(length: number): { tasks: TaskNode[]; edges: Edge[] } {
  const tasks: TaskNode[] = [];
  const edges: Edge[] = [];
  for (let i = 0; i < length; i++) {
    tasks.push(makeNode(`t${i}`));
    if (i > 0) {
      edges.push(makeEdge(`t${i}`, `t${i - 1}`));
    }
  }
  return { tasks, edges };
}

/**
 * Creates a diamond DAG:
 *       A
 *      / \
 *     B   C
 *      \ /
 *       D
 * D depends on B and C; B and C depend on A.
 */
function createDiamondDAG(): { tasks: TaskNode[]; edges: Edge[] } {
  return {
    tasks: [makeNode('A'), makeNode('B'), makeNode('C'), makeNode('D')],
    edges: [
      makeEdge('B', 'A'),
      makeEdge('C', 'A'),
      makeEdge('D', 'B'),
      makeEdge('D', 'C')
    ]
  };
}

/**
 * Creates a deep tree of depth N.
 * Root has 2 children, each child has 2 children, etc.
 */
function createDeepTree(depth: number): { tasks: TaskNode[]; edges: Edge[] } {
  const tasks: TaskNode[] = [];
  const edges: Edge[] = [];
  let counter = 0;

  function addLevel(parentId: string | null, level: number) {
    const id = `t${counter++}`;
    tasks.push(makeNode(id));
    if (parentId !== null) {
      edges.push(makeEdge(id, parentId));
    }
    if (level < depth) {
      addLevel(id, level + 1);
      addLevel(id, level + 1);
    }
  }

  addLevel(null, 1);
  return { tasks, edges };
}

/**
 * Creates a large DAG with N independent tasks (no edges).
 */
function createLargeDAG(size: number): { tasks: TaskNode[]; edges: Edge[] } {
  const tasks: TaskNode[] = [];
  for (let i = 0; i < size; i++) {
    tasks.push(makeNode(`t${i}`));
  }
  return { tasks, edges: [] };
}

describe('DAGService', () => {
  let dag: DAGService;

  beforeEach(() => {
    dag = new DAGService();
  });

  // ============================================================================
  // validateNoCycle
  // ============================================================================

  describe('validateNoCycle', () => {
    it('should return true for a safe edge with no existing edges', () => {
      expect(dag.validateNoCycle('A', 'B', [])).toBe(true);
    });

    it('should return false for self-dependency', () => {
      expect(dag.validateNoCycle('A', 'A', [])).toBe(false);
    });

    it('should return false for direct cycle (A->B, adding B->A)', () => {
      const edges = [makeEdge('A', 'B')];
      // Adding B depends on A: would create B->A->B cycle
      expect(dag.validateNoCycle('B', 'A', edges)).toBe(false);
    });

    it('should return true for non-cyclic addition', () => {
      const edges = [makeEdge('A', 'B')];
      // Adding C depends on A: no cycle
      expect(dag.validateNoCycle('C', 'A', edges)).toBe(true);
    });

    it('should detect indirect cycle (A->B->C, adding C->A)', () => {
      const edges = [
        makeEdge('A', 'B'),
        makeEdge('B', 'C')
      ];
      // Adding C depends on A: would create C->A->B->C cycle
      expect(dag.validateNoCycle('C', 'A', edges)).toBe(false);
    });

    it('should return true when adding edge that does not create cycle in complex graph', () => {
      // A->B, A->C, B->D, C->D
      const edges = [
        makeEdge('A', 'B'),
        makeEdge('A', 'C'),
        makeEdge('B', 'D'),
        makeEdge('C', 'D')
      ];
      // Adding E depends on D: safe
      expect(dag.validateNoCycle('E', 'D', edges)).toBe(true);
    });

    it('should detect cycle in diamond DAG', () => {
      const { edges } = createDiamondDAG();
      // Adding A depends on D: would create A->...->D->...->A cycle
      expect(dag.validateNoCycle('A', 'D', edges)).toBe(false);
    });

    it('should handle deep chain cycle detection', () => {
      const { edges } = createLinearChain(10);
      // t9 -> t8 -> ... -> t0. Adding t0 depends on t9 would create cycle
      expect(dag.validateNoCycle('t0', 't9', edges)).toBe(false);
    });

    it('should return true for parallel addition in deep chain', () => {
      const { edges } = createLinearChain(5);
      // Adding an independent edge that doesn't create a cycle
      expect(dag.validateNoCycle('t4', 't0', edges)).toBe(true);
      // t4 already depends on t3, and t0 is at the start. But adding t4->t0
      // is redundant but not cyclic. Let me verify: t4->t3->t2->t1->t0.
      // Adding t4 depends on t0 is safe (no cycle, just redundant path)
    });

    it('should handle empty edge list', () => {
      expect(dag.validateNoCycle('A', 'B', [])).toBe(true);
    });

    it('should handle edge list with unrelated tasks', () => {
      const edges = [
        makeEdge('X', 'Y'),
        makeEdge('Y', 'Z')
      ];
      expect(dag.validateNoCycle('A', 'B', edges)).toBe(true);
    });

    it('should detect cycle through branching paths', () => {
      // A->B, A->C, B->D, C->D, D->E
      const edges = [
        makeEdge('A', 'B'),
        makeEdge('A', 'C'),
        makeEdge('B', 'D'),
        makeEdge('C', 'D'),
        makeEdge('D', 'E')
      ];
      // Adding E depends on A: E->A->B->D->E or E->A->C->D->E
      expect(dag.validateNoCycle('E', 'A', edges)).toBe(false);
    });
  });

  // ============================================================================
  // topologicalSort
  // ============================================================================

  describe('topologicalSort', () => {
    it('should return tasks in order for linear chain', () => {
      const { tasks, edges } = createLinearChain(4);
      const sorted = dag.topologicalSort(tasks, edges);

      expect(sorted).toHaveLength(4);
      // t0 has no deps, should come first
      expect(sorted[0].id).toBe('t0');
      // t3 depends on t2 depends on t1 depends on t0
      const indexOfT0 = sorted.findIndex(t => t.id === 't0');
      const indexOfT1 = sorted.findIndex(t => t.id === 't1');
      const indexOfT2 = sorted.findIndex(t => t.id === 't2');
      const indexOfT3 = sorted.findIndex(t => t.id === 't3');
      expect(indexOfT0).toBeLessThan(indexOfT1);
      expect(indexOfT1).toBeLessThan(indexOfT2);
      expect(indexOfT2).toBeLessThan(indexOfT3);
    });

    it('should handle diamond DAG', () => {
      const { tasks, edges } = createDiamondDAG();
      const sorted = dag.topologicalSort(tasks, edges);

      expect(sorted).toHaveLength(4);
      const indexA = sorted.findIndex(t => t.id === 'A');
      const indexB = sorted.findIndex(t => t.id === 'B');
      const indexC = sorted.findIndex(t => t.id === 'C');
      const indexD = sorted.findIndex(t => t.id === 'D');

      // A must come before B and C
      expect(indexA).toBeLessThan(indexB);
      expect(indexA).toBeLessThan(indexC);
      // B and C must come before D
      expect(indexB).toBeLessThan(indexD);
      expect(indexC).toBeLessThan(indexD);
    });

    it('should return all tasks for graph with no edges', () => {
      const tasks = [makeNode('A'), makeNode('B'), makeNode('C')];
      const sorted = dag.topologicalSort(tasks, []);
      expect(sorted).toHaveLength(3);
    });

    it('should return single task', () => {
      const sorted = dag.topologicalSort([makeNode('A')], []);
      expect(sorted).toHaveLength(1);
      expect(sorted[0].id).toBe('A');
    });

    it('should return empty array for empty input', () => {
      const sorted = dag.topologicalSort([], []);
      expect(sorted).toEqual([]);
    });

    it('should handle multiple independent chains', () => {
      // Chain 1: A->B, Chain 2: C->D
      const tasks = [makeNode('A'), makeNode('B'), makeNode('C'), makeNode('D')];
      const edges = [makeEdge('B', 'A'), makeEdge('D', 'C')];
      const sorted = dag.topologicalSort(tasks, edges);

      expect(sorted).toHaveLength(4);
      const indexA = sorted.findIndex(t => t.id === 'A');
      const indexB = sorted.findIndex(t => t.id === 'B');
      const indexC = sorted.findIndex(t => t.id === 'C');
      const indexD = sorted.findIndex(t => t.id === 'D');
      expect(indexA).toBeLessThan(indexB);
      expect(indexC).toBeLessThan(indexD);
    });

    it('should handle deep tree', () => {
      const { tasks, edges } = createDeepTree(3);
      const sorted = dag.topologicalSort(tasks, edges);

      // All tasks should be included
      expect(sorted).toHaveLength(tasks.length);

      // For every edge, the dependency should appear before the dependent
      for (const edge of edges) {
        const depIndex = sorted.findIndex(t => t.id === edge.dependsOnTaskId);
        const taskIndex = sorted.findIndex(t => t.id === edge.taskId);
        expect(depIndex).toBeLessThan(taskIndex);
      }
    });

    it('should handle large DAG without errors', () => {
      const { tasks } = createLargeDAG(100);
      const sorted = dag.topologicalSort(tasks, []);
      expect(sorted).toHaveLength(100);
    });

    it('should silently drop cyclic nodes (Kahn algorithm behavior)', () => {
      // A->B->C->A forms a cycle; D is independent
      const tasks = [makeNode('A'), makeNode('B'), makeNode('C'), makeNode('D')];
      const edges = [
        makeEdge('A', 'B'),
        makeEdge('B', 'C'),
        makeEdge('C', 'A')
      ];
      const sorted = dag.topologicalSort(tasks, edges);

      // Kahn's algorithm only emits nodes whose in-degree reaches 0.
      // A, B, C are in a cycle so none of them reach in-degree 0.
      // Only D (independent, no edges) should appear in the result.
      expect(sorted).toHaveLength(1);
      expect(sorted[0].id).toBe('D');
    });
  });

  // ============================================================================
  // getNextActions
  // ============================================================================

  describe('getNextActions', () => {
    it('should return all todo tasks with no edges', () => {
      const tasks = [makeNode('A'), makeNode('B'), makeNode('C')];
      const result = dag.getNextActions(tasks, []);
      expect(result).toHaveLength(3);
    });

    it('should return only tasks with completed dependencies', () => {
      const tasks = [
        makeNode('A', 'done'),
        makeNode('B', 'todo'),
        makeNode('C', 'todo')
      ];
      const edges = [
        makeEdge('B', 'A'),  // B depends on A (done)
        makeEdge('C', 'B')   // C depends on B (todo, not done)
      ];
      const result = dag.getNextActions(tasks, edges);

      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('B');
    });

    it('should not include in_progress, done, or cancelled tasks', () => {
      const tasks = [
        makeNode('A', 'in_progress'),
        makeNode('B', 'done'),
        makeNode('C', 'cancelled'),
        makeNode('D', 'todo')
      ];
      const result = dag.getNextActions(tasks, []);
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('D');
    });

    it('should treat cancelled dependencies as satisfied', () => {
      const tasks = [
        makeNode('A', 'cancelled'),
        makeNode('B', 'todo')
      ];
      const edges = [makeEdge('B', 'A')];
      const result = dag.getNextActions(tasks, edges);

      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('B');
    });

    it('should return empty for all tasks blocked', () => {
      const tasks = [
        makeNode('A', 'in_progress'),
        makeNode('B', 'todo')
      ];
      const edges = [makeEdge('B', 'A')];
      const result = dag.getNextActions(tasks, edges);
      expect(result).toHaveLength(0);
    });

    it('should handle diamond DAG with partial completion', () => {
      const tasks = [
        makeNode('A', 'done'),
        makeNode('B', 'todo'),
        makeNode('C', 'todo'),
        makeNode('D', 'todo')
      ];
      const edges = [
        makeEdge('B', 'A'),
        makeEdge('C', 'A'),
        makeEdge('D', 'B'),
        makeEdge('D', 'C')
      ];
      const result = dag.getNextActions(tasks, edges);

      // B and C are ready (A is done), D is blocked (B and C not done)
      expect(result).toHaveLength(2);
      const ids = result.map(t => t.id).sort();
      expect(ids).toEqual(['B', 'C']);
    });

    it('should return empty array for empty input', () => {
      expect(dag.getNextActions([], [])).toEqual([]);
    });

    it('should handle task with multiple satisfied dependencies', () => {
      const tasks = [
        makeNode('A', 'done'),
        makeNode('B', 'done'),
        makeNode('C', 'todo')
      ];
      const edges = [
        makeEdge('C', 'A'),
        makeEdge('C', 'B')
      ];
      const result = dag.getNextActions(tasks, edges);
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('C');
    });

    it('should handle task with one unsatisfied dependency among many', () => {
      const tasks = [
        makeNode('A', 'done'),
        makeNode('B', 'in_progress'),
        makeNode('C', 'todo')
      ];
      const edges = [
        makeEdge('C', 'A'),
        makeEdge('C', 'B')
      ];
      const result = dag.getNextActions(tasks, edges);
      expect(result).toHaveLength(0);
    });

    it('should handle edges referencing non-existent tasks', () => {
      const tasks = [makeNode('A', 'todo')];
      const edges = [makeEdge('A', 'nonexistent')];
      // nonexistent task has no status -> not in taskStatusMap -> dep is not found
      // so it won't be added to incompleteDeps -> A should be actionable
      const result = dag.getNextActions(tasks, edges);
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('A');
    });
  });

  // ============================================================================
  // getBlockedTasks
  // ============================================================================

  describe('getBlockedTasks', () => {
    it('should return empty for tasks with no dependencies', () => {
      const tasks = [makeNode('A'), makeNode('B')];
      const result = dag.getBlockedTasks(tasks, []);
      expect(result).toHaveLength(0);
    });

    it('should identify blocked todo tasks', () => {
      const tasks = [
        makeNode('A', 'in_progress'),
        makeNode('B', 'todo')
      ];
      const edges = [makeEdge('B', 'A')];
      const result = dag.getBlockedTasks(tasks, edges);

      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('B');
    });

    it('should identify blocked in_progress tasks', () => {
      const tasks = [
        makeNode('A', 'todo'),
        makeNode('B', 'in_progress')
      ];
      const edges = [makeEdge('B', 'A')];
      const result = dag.getBlockedTasks(tasks, edges);

      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('B');
    });

    it('should not include done or cancelled tasks as blocked', () => {
      const tasks = [
        makeNode('A', 'todo'),
        makeNode('B', 'done'),
        makeNode('C', 'cancelled')
      ];
      const edges = [
        makeEdge('B', 'A'),
        makeEdge('C', 'A')
      ];
      const result = dag.getBlockedTasks(tasks, edges);
      expect(result).toHaveLength(0);
    });

    it('should not count done/cancelled dependencies as blockers', () => {
      const tasks = [
        makeNode('A', 'done'),
        makeNode('B', 'todo')
      ];
      const edges = [makeEdge('B', 'A')];
      const result = dag.getBlockedTasks(tasks, edges);
      expect(result).toHaveLength(0);
    });

    it('should handle diamond DAG with all incomplete deps', () => {
      const tasks = [
        makeNode('A', 'todo'),
        makeNode('B', 'todo'),
        makeNode('C', 'todo'),
        makeNode('D', 'todo')
      ];
      const edges = [
        makeEdge('B', 'A'),
        makeEdge('C', 'A'),
        makeEdge('D', 'B'),
        makeEdge('D', 'C')
      ];
      const result = dag.getBlockedTasks(tasks, edges);

      // B, C blocked by A. D blocked by B and C.
      expect(result).toHaveLength(3);
      const blockedIds = result.map(t => t.id).sort();
      expect(blockedIds).toEqual(['B', 'C', 'D']);
    });

    it('should return empty for empty input', () => {
      expect(dag.getBlockedTasks([], [])).toEqual([]);
    });
  });

  // ============================================================================
  // getDependencyTree
  // ============================================================================

  describe('getDependencyTree', () => {
    it('should return empty arrays for isolated task', () => {
      const tasks = [makeNode('A')];
      const result = dag.getDependencyTree('A', tasks, []);
      expect(result.dependencies).toEqual([]);
      expect(result.dependents).toEqual([]);
    });

    it('should return direct dependencies', () => {
      const tasks = [makeNode('A'), makeNode('B')];
      const edges = [makeEdge('B', 'A')];
      const result = dag.getDependencyTree('B', tasks, edges);

      expect(result.dependencies).toContain('A');
      expect(result.dependents).toEqual([]);
    });

    it('should return direct dependents', () => {
      const tasks = [makeNode('A'), makeNode('B')];
      const edges = [makeEdge('B', 'A')];
      const result = dag.getDependencyTree('A', tasks, edges);

      expect(result.dependencies).toEqual([]);
      expect(result.dependents).toContain('B');
    });

    it('should return transitive dependencies', () => {
      const { tasks, edges } = createLinearChain(4);
      // t3 -> t2 -> t1 -> t0
      const result = dag.getDependencyTree('t3', tasks, edges);

      expect(result.dependencies).toHaveLength(3);
      expect(result.dependencies).toContain('t0');
      expect(result.dependencies).toContain('t1');
      expect(result.dependencies).toContain('t2');
      expect(result.dependents).toEqual([]);
    });

    it('should return transitive dependents', () => {
      const { tasks, edges } = createLinearChain(4);
      const result = dag.getDependencyTree('t0', tasks, edges);

      expect(result.dependencies).toEqual([]);
      expect(result.dependents).toHaveLength(3);
      expect(result.dependents).toContain('t1');
      expect(result.dependents).toContain('t2');
      expect(result.dependents).toContain('t3');
    });

    it('should return both directions for middle node', () => {
      const { tasks, edges } = createLinearChain(5);
      // t4 -> t3 -> t2 -> t1 -> t0
      const result = dag.getDependencyTree('t2', tasks, edges);

      expect(result.dependencies).toHaveLength(2);
      expect(result.dependencies).toContain('t0');
      expect(result.dependencies).toContain('t1');

      expect(result.dependents).toHaveLength(2);
      expect(result.dependents).toContain('t3');
      expect(result.dependents).toContain('t4');
    });

    it('should handle diamond DAG from bottom', () => {
      const { tasks, edges } = createDiamondDAG();
      const result = dag.getDependencyTree('D', tasks, edges);

      // D depends on B and C, which depend on A
      expect(result.dependencies).toHaveLength(3);
      expect(result.dependencies).toContain('A');
      expect(result.dependencies).toContain('B');
      expect(result.dependencies).toContain('C');
      expect(result.dependents).toEqual([]);
    });

    it('should handle diamond DAG from top', () => {
      const { tasks, edges } = createDiamondDAG();
      const result = dag.getDependencyTree('A', tasks, edges);

      expect(result.dependencies).toEqual([]);
      expect(result.dependents).toHaveLength(3);
      expect(result.dependents).toContain('B');
      expect(result.dependents).toContain('C');
      expect(result.dependents).toContain('D');
    });

    it('should handle non-existent root task gracefully', () => {
      const tasks = [makeNode('A')];
      const result = dag.getDependencyTree('nonexistent', tasks, []);
      expect(result.dependencies).toEqual([]);
      expect(result.dependents).toEqual([]);
    });

    it('should not include duplicates in results', () => {
      // A->B, A->C, B->D, C->D (diamond)
      const { tasks, edges } = createDiamondDAG();
      const result = dag.getDependencyTree('D', tasks, edges);

      // A should appear only once even though reachable via B and C
      const uniqueDeps = new Set(result.dependencies);
      expect(uniqueDeps.size).toBe(result.dependencies.length);
    });

    it('should handle deep tree from root', () => {
      const { tasks, edges } = createDeepTree(3);
      const result = dag.getDependencyTree('t0', tasks, edges);

      expect(result.dependencies).toEqual([]);
      // Root should have all other tasks as dependents
      expect(result.dependents.length).toBeGreaterThan(0);
    });
  });
});
