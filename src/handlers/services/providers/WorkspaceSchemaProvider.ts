/**
 * Location: /src/handlers/services/providers/WorkspaceSchemaProvider.ts
 * Purpose: Schema provider for injecting dynamic workspace information into MemoryManager tool schemas
 * 
 * This file enhances MemoryManager workspace-related modes with actual workspace IDs, names,
 * descriptions, and counts to help Claude understand available workspace options.
 * 
 * Used by: SchemaEnhancementService to enhance MemoryManager schemas during tool registration
 * Integrates with: WorkspaceService to query current workspace information
 */

import { ISchemaProvider, EnhancedJSONSchema } from '../../interfaces/ISchemaProvider';
import { WorkspaceService, GLOBAL_WORKSPACE_ID } from '../../../services/WorkspaceService';
import { logger } from '../../../utils/logger';

/**
 * Workspace enhancement data structure
 */
interface WorkspaceEnhancementData {
  /** Available workspace IDs for enum options */
  workspaceIds: string[];
  /** Workspace details for descriptions */
  workspaces: Array<{
    id: string;
    name: string;
    description?: string;
  }>;
  /** Statistics for schema descriptions */
  stats: {
    totalCount: number;
  };
}

/**
 * Schema provider for workspace-related enhancements
 */
export class WorkspaceSchemaProvider implements ISchemaProvider {
  public readonly name = 'WorkspaceSchemaProvider';
  public readonly description = 'Enhances MemoryManager schemas with dynamic workspace information';

  private workspaceService: WorkspaceService;
  private targetModes: string[];
  private cache: Map<string, WorkspaceEnhancementData> = new Map();
  private enableCaching: boolean;

  /**
   * Create a new WorkspaceSchemaProvider
   * @param workspaceService WorkspaceService instance for querying workspaces
   * @param targetModes Specific modes to target (defaults to workspace modes)
   * @param enableCaching Whether to enable caching (defaults to true)
   */
  constructor(
    workspaceService: WorkspaceService,
    targetModes: string[] = ['loadWorkspace', 'listWorkspaces'],
    enableCaching: boolean = true
  ) {
    this.workspaceService = workspaceService;
    this.targetModes = targetModes;
    this.enableCaching = enableCaching;
  }

  /**
   * Check if this provider can enhance the given tool schema
   * @param toolName Tool name (e.g., "memoryManager")
   * @param baseSchema Base schema to potentially enhance
   * @returns Promise<boolean> true if this provider can enhance the schema
   */
  async canEnhance(toolName: string, baseSchema: EnhancedJSONSchema): Promise<boolean> {
    try {
      // Extract agent name from tool name (handle both "memoryManager" and "memoryManager_vaultName" formats)
      const agentName = toolName.split('_')[0];
      
      // Only enhance memoryManager agent
      if (agentName !== 'memoryManager') {
        return false;
      }

      // Check if the schema has mode property with workspace-related modes
      if (!baseSchema?.properties?.mode?.enum) {
        return false;
      }

      // Check if any target modes are present in the schema
      const schemaModes = baseSchema.properties.mode.enum as string[];
      const hasTargetMode = this.targetModes.some(mode => schemaModes.includes(mode));
      
      logger.systemLog(`canEnhance(${toolName}): ${hasTargetMode}`, 'WorkspaceSchemaProvider');
      return hasTargetMode;

    } catch (error) {
      logger.systemError(error instanceof Error ? error : new Error(String(error)), 'WorkspaceSchemaProvider canEnhance');
      return false;
    }
  }

  /**
   * Enhance the given schema with workspace information
   * @param toolName Tool name
   * @param baseSchema Base schema to enhance
   * @returns Promise<EnhancedJSONSchema> The enhanced schema
   */
  async enhanceSchema(toolName: string, baseSchema: EnhancedJSONSchema): Promise<EnhancedJSONSchema> {
    try {
      // Get workspace data
      const workspaceData = await this.fetchEnhancementData();

      // Apply enhancements to schema
      const enhancedSchema = this.applyEnhancement(baseSchema, workspaceData);

      logger.systemLog(`Enhanced schema for ${toolName} with ${workspaceData.workspaceIds.length} workspaces`, 'WorkspaceSchemaProvider');
      return enhancedSchema;

    } catch (error) {
      logger.systemError(error instanceof Error ? error : new Error(String(error)), `WorkspaceSchemaProvider enhanceSchema for ${toolName}`);
      
      // Return original schema on error
      return baseSchema;
    }
  }

  /**
   * Get the priority of this provider
   * @returns Priority number (higher = higher priority)
   */
  getPriority(): number {
    return 100; // High priority for workspace information
  }

  /**
   * Fetch workspace enhancement data
   * @returns Workspace enhancement data
   */
  private async fetchEnhancementData(): Promise<WorkspaceEnhancementData> {
    const cacheKey = 'workspace_data';
    
    // Check cache first
    if (this.enableCaching && this.cache.has(cacheKey)) {
      const cachedData = this.cache.get(cacheKey)!;
      logger.systemLog(`Using cached workspace data (${cachedData.stats.totalCount} workspaces)`, 'WorkspaceSchemaProvider');
      return cachedData;
    }

    try {
      // Query all workspaces
      const workspaces = await this.workspaceService.listWorkspaces();

      logger.systemLog(`Fetched ${workspaces.length} workspaces for schema enhancement`, 'WorkspaceSchemaProvider');

      // Extract workspace IDs and details
      const workspaceIds = workspaces.map(ws => ws.id);
      const workspaceDetails = workspaces.map(ws => ({
        id: ws.id,
        name: ws.name || 'Unnamed Workspace',
        description: ws.description
      }));

      // Calculate statistics
      const stats = {
        totalCount: workspaces.length
      };

      const enhancementData = {
        workspaceIds,
        workspaces: workspaceDetails,
        stats
      };

      // Cache the data if caching is enabled
      if (this.enableCaching) {
        this.cache.set(cacheKey, enhancementData);
      }

      return enhancementData;

    } catch (error) {
      logger.systemError(error instanceof Error ? error : new Error(String(error)), 'WorkspaceSchemaProvider fetchEnhancementData');
      
      // Return minimal fallback data with global workspace
      const fallbackData = {
        workspaceIds: [GLOBAL_WORKSPACE_ID],
        workspaces: [{
          id: GLOBAL_WORKSPACE_ID,
          name: 'Global Workspace',
          description: 'Default workspace for general work'
        }],
        stats: {
          totalCount: 1
        }
      };

      // Cache fallback data too
      if (this.enableCaching) {
        this.cache.set(cacheKey, fallbackData);
      }

      return fallbackData;
    }
  }

  /**
   * Apply workspace enhancement to schema
   * @param originalSchema Original schema
   * @param enhancementData Workspace enhancement data
   * @returns Enhanced schema
   */
  private applyEnhancement(originalSchema: EnhancedJSONSchema, enhancementData: WorkspaceEnhancementData): EnhancedJSONSchema {
    // Deep clone the original schema
    const enhancedSchema = JSON.parse(JSON.stringify(originalSchema));

    // Ensure properties exist
    if (!enhancedSchema.properties) {
      enhancedSchema.properties = {};
    }

    // Check which modes are available in this schema and enhance them
    const schemaModes = enhancedSchema.properties?.mode?.enum as string[] || [];
    
    // Enhance loadWorkspace mode if it exists
    if (schemaModes.includes('loadWorkspace') && this.targetModes.includes('loadWorkspace')) {
      this.enhanceLoadWorkspaceSchema(enhancedSchema, enhancementData);
    }

    // Enhance listWorkspaces mode if it exists
    if (schemaModes.includes('listWorkspaces') && this.targetModes.includes('listWorkspaces')) {
      this.enhanceListWorkspacesSchema(enhancedSchema, enhancementData);
    }

    return enhancedSchema;
  }

  /**
   * Enhance loadWorkspace mode schema with workspace options
   * @param schema Schema to enhance
   * @param data Enhancement data
   */
  private enhanceLoadWorkspaceSchema(schema: EnhancedJSONSchema, data: WorkspaceEnhancementData): void {
    if (!schema.properties || !schema.properties.id) {
      return; // Skip if 'id' parameter doesn't exist
    }

    const idProp = schema.properties.id as EnhancedJSONSchema;
    // Add enum with available workspace IDs
    idProp.enum = data.workspaceIds;

    // Enhance description with available workspaces
    const workspaceList = data.workspaces
      .map(ws => `"${ws.id}": ${ws.name}${ws.description ? ` - ${ws.description}` : ''}`)
      .join(', ');

    idProp.description =
      `Workspace ID to load (REQUIRED). Available workspaces (${data.stats.totalCount} total): ${workspaceList}`;

    // Add workspace count information to schema description
    if (!schema.description) {
      schema.description = 'Load a workspace by ID and restore context and state';
    }

    schema.description += ` | ${data.stats.totalCount} workspaces available`;

    logger.systemLog(`Enhanced loadWorkspace schema with ${data.workspaceIds.length} workspace options`, 'WorkspaceSchemaProvider');
  }

  /**
   * Enhance listWorkspaces mode schema with workspace statistics
   * @param schema Schema to enhance
   * @param data Enhancement data
   */
  private enhanceListWorkspacesSchema(schema: EnhancedJSONSchema, data: WorkspaceEnhancementData): void {
    // Enhance schema description with current workspace counts
    if (!schema.description) {
      schema.description = 'List available workspaces with filters and sorting';
    }

    schema.description += ` | Current workspace inventory: ${data.stats.totalCount} total`;

    logger.systemLog(`Enhanced listWorkspaces schema with workspace statistics`, 'WorkspaceSchemaProvider');
  }

  /**
   * Create a pre-configured instance for MemoryManager workspace modes
   * @param workspaceService WorkspaceService instance
   * @returns Configured WorkspaceSchemaProvider
   */
  static forMemoryManager(workspaceService: WorkspaceService): WorkspaceSchemaProvider {
    return new WorkspaceSchemaProvider(
      workspaceService,
      ['loadWorkspace', 'listWorkspaces'],
      true
    );
  }

  /**
   * Create a provider for specific workspace modes
   * @param workspaceService WorkspaceService instance
   * @param targetModes Specific modes to target
   * @returns Configured WorkspaceSchemaProvider
   */
  static forModes(workspaceService: WorkspaceService, targetModes: string[]): WorkspaceSchemaProvider {
    return new WorkspaceSchemaProvider(workspaceService, targetModes, true);
  }

  /**
   * Clear the cache (useful for testing or when workspace data changes)
   */
  public clearCache(): void {
    this.cache.clear();
  }

  /**
   * Get the current cache size
   * @returns Number of cached entries
   */
  public getCacheSize(): number {
    return this.cache.size;
  }
}