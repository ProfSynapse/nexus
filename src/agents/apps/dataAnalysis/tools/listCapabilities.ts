/**
 * ListCapabilitiesTool — advertise the sandbox's available packages and the
 * supported input formats so the AI knows what it can write against.
 */

import { BaseTool } from '../../../baseTool';
import { CommonParameters, CommonResult } from '../../../../types';
import { JSONSchema } from '../../../../types/schema/JSONSchemaTypes';
import { isDesktop } from '../../../../utils/platform';
import { BaseAppAgent } from '../../BaseAppAgent';
import { SUPPORTED_PACKAGES } from '../types';

export class ListCapabilitiesTool extends BaseTool<CommonParameters, CommonResult> {
  private agent: BaseAppAgent;

  constructor(agent: BaseAppAgent) {
    super(
      'listCapabilities',
      'List Capabilities',
      'List the Python packages and input formats supported by the Data Analysis sandbox.',
      '0.1.0'
    );
    this.agent = agent;
  }

  execute(): Promise<CommonResult> {
    return Promise.resolve(
      this.prepareResult(true, {
        runtime: 'Pyodide (CPython 3.13, WebAssembly)',
        desktopOnly: true,
        sandbox:
          'Off-thread Web Worker, no Node integration, in-memory filesystem. Best-effort ' +
          'isolation: blocks accidental network/vault access; not a hard sandbox for hostile code.',
        packages: [...SUPPORTED_PACKAGES],
        inputFormats: ['.csv', '.xlsx'],
        notes: [
          "Read inputs via the injected `inputs` dict: pd.read_csv(inputs['name']) / pd.read_excel(inputs['name']).",
          'Return a JSON-serializable value (e.g. df...to_dict("records")).',
          'Results over maxRows (default 1500) are rejected — aggregate or limit.',
        ],
        available: isDesktop(),
      })
    );
  }

  getParameterSchema(): JSONSchema {
    return this.getMergedSchema({ type: 'object', properties: {} });
  }
}
