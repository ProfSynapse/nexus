/**
 * UseToolTool - Execution tool for the two-tool architecture
 * Single entry point for executing tools with context-first design
 *
 * Note: This tool implements ITool directly instead of extending BaseTool
 * because it uses a different context format (ToolContext) than CommonParameters.
 */

import { ITool } from '../../interfaces/ITool';
import { UseToolParams, UseToolResult, getToolContextSchema } from '../types';
import { ToolBatchExecutionService } from '../services/ToolBatchExecutionService';

/**
 * Tool for executing other tools with unified context
 * Implements ITool directly since UseToolParams has its own context format
 */
export class UseToolTool implements ITool<UseToolParams, UseToolResult> {
  slug: string;
  name: string;
  description: string;
  version: string;

  constructor(private batchExecutionService: ToolBatchExecutionService) {
    this.slug = 'useTools';
    this.name = 'Use Tools';
    this.description = 'Execute tools. IMPORTANT: You MUST call getTools first to get the parameter schemas before calling this tool. Do NOT guess or hallucinate parameters - call getTools to discover the exact schema, then call useTools with those parameters. Fill context (memory→goal→constraints), then specify tools.';
    this.version = '1.0.0';
  }

  /**
   * Execute the tool
   * @param params Tool parameters
   * @returns Promise that resolves with execution results
   */
  async execute(params: UseToolParams): Promise<UseToolResult> {
    return await this.batchExecutionService.execute(params);
  }

  /**
   * Get the JSON schema for the tool's parameters
   */
  getParameterSchema(): Record<string, unknown> {
    return {
      type: 'object',
      properties: {
        context: getToolContextSchema(),
        strategy: {
          type: 'string',
          enum: ['serial', 'parallel'],
          default: 'serial',
          description: 'Execution strategy: serial (stop on error) or parallel (run all)'
        },
        calls: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              agent: {
                type: 'string',
                description: 'Agent name'
              },
              tool: {
                type: 'string',
                description: 'Tool name'
              },
              params: {
                type: 'object',
                description: 'Tool-specific parameters'
              },
              continueOnFailure: {
                type: 'boolean',
                description: 'Continue despite errors (serial only)'
              }
            },
            required: ['agent', 'tool', 'params']
          },
          minItems: 1,
          description: 'Tool calls to execute'
        }
      },
      required: ['context', 'calls']
    };
  }

  /**
   * Get the JSON schema for the tool's result
   */
  getResultSchema(): Record<string, unknown> {
    return {
      type: 'object',
      properties: {
        success: {
          type: 'boolean',
          description: 'True if all calls succeeded'
        },
        error: {
          type: 'string',
          description: 'Error message if any calls failed'
        },
        data: {
          type: 'object',
          properties: {
            results: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  agent: { type: 'string', description: 'Agent that executed the tool' },
                  tool: { type: 'string', description: 'Tool that was executed' },
                  success: { type: 'boolean', description: 'Whether this call succeeded' },
                  error: { type: 'string', description: 'Error message if failed' },
                  data: { description: 'Result data (only for tools that return data)' }
                },
                required: ['agent', 'tool', 'success']
              }
            }
          }
        }
      }
    };
  }
}
