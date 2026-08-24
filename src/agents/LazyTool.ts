import { ITool } from './interfaces/ITool';
import { JSONSchema } from '../types/schema/JSONSchemaTypes';
import type {
  ToolExecutionPolicy,
  ToolMutationIntent,
} from './policy/ToolExecutionPolicy';
import { CONSERVATIVE_TOOL_EXECUTION_POLICY } from './policy/ToolExecutionPolicy';

/**
 * Descriptor for lazy tool registration.
 * Holds static metadata so tool instances are only created on first use.
 */
export interface LazyToolDescriptor {
  slug: string;
  name: string;
  description: string;
  version: string;
  factory: () => ITool;
  executionPolicy?: Readonly<ToolExecutionPolicy>;
}

/**
 * Proxy that implements ITool but defers real tool construction until first use.
 *
 * Metadata (slug, name, description, version) is available immediately without
 * instantiating the underlying tool. Methods that require the real tool
 * (getParameterSchema, getResultSchema, execute) trigger lazy construction
 * on first call.
 */
export class LazyTool implements ITool {
  readonly slug: string;
  readonly name: string;
  readonly description: string;
  readonly version: string;

  private _factory: (() => ITool) | null;
  private _instance: ITool | null = null;
  private readonly executionPolicy: Readonly<ToolExecutionPolicy>;

  constructor(descriptor: LazyToolDescriptor) {
    this.slug = descriptor.slug;
    this.name = descriptor.name;
    this.description = descriptor.description;
    this.version = descriptor.version;
    this._factory = descriptor.factory;
    this.executionPolicy = descriptor.executionPolicy ?? CONSERVATIVE_TOOL_EXECUTION_POLICY;
  }

  /**
   * Get or create the real tool instance.
   * Constructs on first call, caches for subsequent calls, releases factory closure.
   */
  private getInstance(): ITool {
    if (!this._instance) {
      const factory = this._factory;
      if (!factory) {
        throw new Error('LazyTool factory is unavailable before instance initialization.');
      }

      this._instance = factory();
      this._factory = null; // Release closure for GC
    }
    return this._instance;
  }

  getParameterSchema(): JSONSchema {
    return this.getInstance().getParameterSchema();
  }

  getResultSchema(): JSONSchema {
    return this.getInstance().getResultSchema();
  }

  getExecutionPolicy(): Readonly<ToolExecutionPolicy> {
    return this.executionPolicy;
  }

  async getMutationIntent(params: unknown): Promise<ToolMutationIntent> {
    const instance = this.getInstance();
    if (!instance.getMutationIntent) {
      throw new Error(`Tool "${this.slug}" does not declare a mutation intent.`);
    }
    return instance.getMutationIntent(params);
  }

  async execute(params: unknown): Promise<unknown> {
    return this.getInstance().execute(params);
  }
}
