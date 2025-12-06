#!/usr/bin/env node
/**
 * Patch script for web-llm FFI compatibility
 *
 * This script adds missing TVM FFI stub functions to the web-llm bundle
 * to enable compatibility with custom-compiled WASMs that have additional
 * FFI imports (like TVMFFIEnvSetStream for stream management).
 *
 * Usage: node scripts/patch-webllm-ffi.js
 */

const fs = require('fs');
const path = require('path');

const WEB_LLM_INDEX = path.join(__dirname, '../node_modules/@mlc-ai/web-llm/lib/index.js');

// Stub function definitions to add (no-ops for WebGPU since streams aren't used)
const STUB_FUNCTIONS = `
// === BEGIN CUSTOM FFI STUBS ===
// Added by patch-webllm-ffi.js for extended context window WASM compatibility
function _TVMFFIEnvSetStream(){return 0;}_TVMFFIEnvSetStream.stub=true;
function _TVMFFIEnvGetStream(){return 0;}_TVMFFIEnvGetStream.stub=true;
// === END CUSTOM FFI STUBS ===
`;

// Pattern to find existing stub functions (they're defined right before wasmImports)
const STUB_MARKER = 'function _TVMFFIWasmFunctionDeleter()';

// Pattern to find the specific TVM wasmImports (the one with TVMFFIWasmFunctionDeleter)
const TVM_WASM_IMPORTS_PATTERN = /wasmImports=\{TVMFFIWasmFunctionDeleter[^}]+\}/;

function patchWebLLM() {
    console.log('Patching web-llm FFI imports...');

    if (!fs.existsSync(WEB_LLM_INDEX)) {
        console.error('Error: web-llm index.js not found at:', WEB_LLM_INDEX);
        process.exit(1);
    }

    let content = fs.readFileSync(WEB_LLM_INDEX, 'utf8');

    // Check if already patched (look for our specific function definition)
    if (content.includes('function _TVMFFIEnvSetStream()')) {
        console.log('Already patched! Skipping.');
        return;
    }

    // Find the stub function marker and insert our stubs before it
    const stubIndex = content.indexOf(STUB_MARKER);
    if (stubIndex === -1) {
        console.error('Error: Could not find stub function marker');
        process.exit(1);
    }

    // Insert our stub functions
    content = content.slice(0, stubIndex) + STUB_FUNCTIONS + content.slice(stubIndex);

    // Now extend wasmImports to include our new stubs
    const match = content.match(TVM_WASM_IMPORTS_PATTERN);
    if (!match) {
        console.error('Error: Could not find TVM wasmImports object (looking for one with TVMFFIWasmFunctionDeleter)');
        process.exit(1);
    }

    // Insert our new entries just before the closing brace
    const originalImports = match[0];
    const newImports = originalImports.replace(/\}$/, ',TVMFFIEnvSetStream:_TVMFFIEnvSetStream,TVMFFIEnvGetStream:_TVMFFIEnvGetStream}');
    content = content.replace(originalImports, newImports);

    // Write back
    fs.writeFileSync(WEB_LLM_INDEX, content);

    console.log('Patch applied successfully!');
    console.log('Added stubs for: TVMFFIEnvSetStream, TVMFFIEnvGetStream');
}

// Also patch the source map if it exists
function patchSourceMap() {
    const mapFile = WEB_LLM_INDEX + '.map';
    if (fs.existsSync(mapFile)) {
        // Just note that source map is now stale
        console.log('Note: Source map at', mapFile, 'is now stale');
    }
}

patchWebLLM();
patchSourceMap();
