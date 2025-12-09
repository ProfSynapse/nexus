/**
 * Script to generate connectorContent.ts from the compiled connector.js
 *
 * This script reads connector.js and embeds its content as a string constant
 * in connectorContent.ts, which is used by ConnectorEnsurer to recreate
 * connector.js if it's missing.
 *
 * Run this after compiling connector.ts:
 *   node scripts/generate-connector-content.mjs
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const connectorJsPath = path.join(__dirname, '..', 'connector.js');
const outputPath = path.join(__dirname, '..', 'src', 'utils', 'connectorContent.ts');

try {
    // Read the compiled connector.js
    const connectorContent = fs.readFileSync(connectorJsPath, 'utf-8');

    // Escape the content for embedding in a template literal
    // We need to escape backticks, backslashes, and ${} template expressions
    const escapedContent = connectorContent
        .replace(/\\/g, '\\\\')  // Escape backslashes first
        .replace(/`/g, '\\`')    // Escape backticks
        .replace(/\$\{/g, '\\${'); // Escape template expressions

    // Generate the TypeScript file
    const outputContent = `/**
 * Auto-generated file containing the embedded connector.js content.
 * This is used by ConnectorEnsurer to recreate connector.js if it's missing.
 *
 * DO NOT EDIT MANUALLY - This file is regenerated during the build process.
 * To update, modify connector.ts and rebuild.
 *
 * Generated: ${new Date().toISOString()}
 */

export const CONNECTOR_JS_CONTENT = \`${escapedContent}\`;
`;

    // Write the output file
    fs.writeFileSync(outputPath, outputContent, 'utf-8');
    console.log('[generate-connector-content] Successfully generated connectorContent.ts');

} catch (error) {
    console.error('[generate-connector-content] Error:', error.message);
    process.exit(1);
}
