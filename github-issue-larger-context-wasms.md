# Feature Request: Pre-compiled WASMs with Larger Context Windows (8K-32K+)

## Summary

The pre-compiled model WASMs in the `binary-mlc-llm-libs` repository are limited to 4K context windows, which significantly limits their usefulness for production applications. Please provide pre-compiled WASMs with larger context windows (8K, 16K, and 32K) for popular models.

## Background

The current pre-compiled WASMs in [binary-mlc-llm-libs](https://github.com/mlc-ai/binary-mlc-llm-libs/tree/main/web-llm-models) are compiled with `context_window_size=4096`. For models like Qwen3-8B that natively support 32K+ context, this is a significant limitation.

## Why This Matters

1. **Use Case Demand**: Applications like chat interfaces, document Q&A, and code assistants benefit greatly from longer context
2. **Custom Compilation Barrier**: Compiling custom WASMs requires:
   - Matching exact TVM/MLC-LLM versions (commits `apache/tvm@c8515e1` and `mlc-ai/mlc-llm@4084e7f` for v0_2_80)
   - Complex build environment setup
   - WASM/runtime version compatibility expertise
3. **Version Mismatch Issues**: Custom-compiled WASMs frequently fail with `LinkError` due to TVM FFI function mismatches (e.g., `TVMFFIEnvSetStream: function import requires a callable`)

## Attempted Solutions

I attempted to compile custom WASMs with extended context following these approaches:

### Approach 1: Using Latest MLC-LLM
```bash
pip install mlc-llm
python -m mlc_llm compile model --device webgpu --overrides "context_window_size=32768"
```
**Result**: `LinkError: TVMFFIEnvSetStream: function import requires a callable`

The web-llm 0.2.80 runtime expects different FFI functions than newer MLC-LLM versions export.

### Approach 2: Building from Exact Commits
Checked out the exact commits from PR #158 in binary-mlc-llm-libs:
- TVM: `apache/tvm@c8515e1`
- MLC-LLM: `mlc-ai/mlc-llm@4084e7f`

**Blockers**:
1. CMake version compatibility issues (many files require patching from `VERSION 3.1` to `3.5`)
2. TVM Python bindings don't match pip-installed native libs
3. Complex dependency chain between mlc_llm → tvm Python module → native libraries

### Approach 3: Patching web-llm Runtime
Added stub functions for missing FFI calls:
```javascript
function _TVMFFIEnvSetStream(){return 0;}_TVMFFIEnvSetStream.stub=true;
function _TVMFFIEnvGetStream(){return 0;}_TVMFFIEnvGetStream.stub=true;
```
**Status**: Partial success - addresses immediate LinkError but may have other incompatibilities

## Request

Please provide pre-compiled WASMs with the following configurations:

### High Priority Models
1. **Qwen3-8B-Instruct**
   - `q4f16_1` quantization
   - Context windows: 8K, 16K, 32K

2. **Qwen3-4B-Instruct**
   - `q4f16_1` quantization
   - Context windows: 8K, 16K

3. **Llama-3-8B-Instruct**
   - `q4f16_1` quantization
   - Context windows: 8K, 16K

### Compilation Command Reference
```bash
python -m mlc_llm compile MODEL_PATH \
  --device webgpu \
  --quantization q4f16_1 \
  --overrides "context_window_size=32768;prefill_chunk_size=4096;max_batch_size=1" \
  -o MODEL-ctx32k-webgpu.wasm
```

## Environment

- web-llm version: 0.2.80
- @mlc-ai/web-runtime: 0.23.0-dev1
- Target: WebGPU (browsers, Electron/Obsidian)
- Host OS: macOS (for testing)

## Additional Context

The WebLLM project is excellent and I want to use it for local LLM inference in Obsidian. The 4K context limitation is the primary blocker for production use. I'm happy to test pre-release builds if you can point me to a working compilation pipeline.

## References

- Related issues: #373, #633 (custom WASM LinkError issues)
- PR #158 in binary-mlc-llm-libs (documents exact commits used)
- MLC-LLM compilation docs: https://llm.mlc.ai/docs/compilation/compile_models.html

---

**Repository**: https://github.com/mlc-ai/web-llm/issues

Thank you for considering this request!
