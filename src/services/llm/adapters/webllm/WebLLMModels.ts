/**
 * WebLLM Model Specifications
 * ============================================================================
 *
 * ╔═══════════════════════════════════════════════════════════════════════════╗
 * ║  HOW TO ADD A NEW MODEL                                                    ║
 * ╠═══════════════════════════════════════════════════════════════════════════╣
 * ║  1. Convert model to WebLLM format (see local-models/ and                 ║
 * ║     extract_text_model.py for the pipeline)                               ║
 * ║  2. Upload to HuggingFace: professorsynapse/[model-name]-webllm           ║
 * ║  3. Add MODEL_LIBS entry if using a new base model architecture           ║
 * ║  4. Add entry to WEBLLM_MODELS array below                                ║
 * ║  5. Run `npm run build` to verify                                         ║
 * ╚═══════════════════════════════════════════════════════════════════════════╝
 *
 * Naming Convention (see Nexus Versioning Spec.md):
 * - Nexus-[SizeClass]-[ProviderCode][BaseVer].[BuildID]
 * - Size Classes: Quark (1-4B), Electron (7-9B), Proton (12-19B), Atom (20-32B+)
 * - Provider Codes: L=Llama, Q=Qwen, M=Mistral, G=Gemma, P=Phi
 *
 * Example model IDs:
 * - nexus-quark-p2.0.1    → Phi-2 based 3B model, build 0.1
 * - nexus-electron-q3.0.1 → Qwen3 based 8B model, build 0.1
 * - nexus-proton-l3.0.1   → Llama3 based 14B model, build 0.1
 */

import { WebLLMModelSpec } from './types';

/**
 * Base URL for HuggingFace model downloads
 */
export const HF_BASE_URL = 'https://huggingface.co';

/**
 * ╔═══════════════════════════════════════════════════════════════════════════╗
 * ║  MODEL LIBRARIES (WASM files)                                              ║
 * ╠═══════════════════════════════════════════════════════════════════════════╣
 * ║  WASM libraries are pre-built by MLC-AI and hosted on GitHub.             ║
 * ║  Add new entries here when using a different base model architecture.     ║
 * ║                                                                            ║
 * ║  Find available libraries at:                                             ║
 * ║  https://github.com/mlc-ai/binary-mlc-llm-libs/tree/main/web-llm-models   ║
 * ║                                                                            ║
 * ║  IMPORTANT: Version must match the WebLLM CDN version (currently v0_2_80) ║
 * ╚═══════════════════════════════════════════════════════════════════════════╝
 */
export const MODEL_LIBS = {
  // Qwen3-1.7B library with 4K context window - from MLC-AI prebuilt libs
  // Optimized for lower VRAM usage (~2GB)
  QWEN3_1_7B_4K: 'https://raw.githubusercontent.com/mlc-ai/binary-mlc-llm-libs/main/web-llm-models/v0_2_80/Qwen3-1.7B-q4f16_1-ctx4k_cs1k-webgpu.wasm',
};

/**
 * ╔═══════════════════════════════════════════════════════════════════════════╗
 * ║  AVAILABLE WEBLLM MODELS                                                   ║
 * ╠═══════════════════════════════════════════════════════════════════════════╣
 * ║  ADD NEW MODELS TO THIS ARRAY                                              ║
 * ║                                                                            ║
 * ║  Each model needs:                                                         ║
 * ║  - id: Unique lowercase identifier (e.g., 'nexus-electron-q3.0.1')        ║
 * ║  - name: Display name for UI (e.g., 'Nexus Electron')                     ║
 * ║  - apiName: Model ID used by WebLLM (usually same as id)                  ║
 * ║  - contextWindow: Max context length in tokens                            ║
 * ║  - maxTokens: Max output tokens                                           ║
 * ║  - vramRequired: Approximate VRAM in GB                                   ║
 * ║  - quantization: Quantization type (e.g., 'q4f16', 'q4f32')              ║
 * ║  - huggingFaceRepo: Full repo path (professorsynapse/[name]-webllm)       ║
 * ║  - modelLibUrl: WASM library from MODEL_LIBS above                        ║
 * ║  - capabilities: What the model supports                                   ║
 * ╚═══════════════════════════════════════════════════════════════════════════╝
 */
export const WEBLLM_MODELS: WebLLMModelSpec[] = [
  // ═══════════════════════════════════════════════════════════════════════════
  // NEXUS QUARK - 1.7B Qwen3-based model fine-tuned for tool calling
  // Uses <tool_call> XML format for function calling (native Qwen3 format)
  // 4K context - optimized for lower VRAM usage (~2GB)
  // Fine-tuned on full toolset - skips getTools, uses useTool directly
  // ═══════════════════════════════════════════════════════════════════════════
  {
    id: 'nexus-quark-q3.0.5',
    name: 'Nexus Quark',
    provider: 'webllm',
    apiName: 'nexus-quark-q3.0.5',
    contextWindow: 4096,
    maxTokens: 2048,
    vramRequired: 2.0,
    quantization: 'q4f16',
    huggingFaceRepo: 'professorsynapse/nexus-quark-q3.0.5',
    modelLibUrl: MODEL_LIBS.QWEN3_1_7B_4K,
    flatStructure: true,
    capabilities: {
      supportsJSON: true,
      supportsImages: false,
      supportsFunctions: true,
      supportsStreaming: true,
      supportsThinking: false,
    },
  },
];

/**
 * Get model by ID
 */
export function getWebLLMModel(modelId: string): WebLLMModelSpec | undefined {
  return WEBLLM_MODELS.find(m => m.id === modelId || m.apiName === modelId);
}

/**
 * Get models that fit within VRAM limit
 */
export function getModelsForVRAM(availableVRAM: number): WebLLMModelSpec[] {
  // Reserve 1.5GB for OS and other applications
  const effectiveVRAM = availableVRAM - 1.5;

  return WEBLLM_MODELS
    .filter(m => m.vramRequired <= effectiveVRAM)
    .sort((a, b) => b.vramRequired - a.vramRequired); // Prefer higher quality
}

/**
 * Get the best model for available VRAM
 */
export function getBestModelForVRAM(availableVRAM: number): WebLLMModelSpec | undefined {
  const models = getModelsForVRAM(availableVRAM);
  return models[0]; // Returns highest quality that fits
}

/**
 * Get download URL for a model file
 */
export function getModelFileUrl(modelSpec: WebLLMModelSpec, fileName: string): string {
  // URL pattern: https://huggingface.co/{repo}/resolve/main/{quantization}/{file}
  return `${HF_BASE_URL}/${modelSpec.huggingFaceRepo}/resolve/main/${modelSpec.quantization}/${fileName}`;
}

/**
 * Get model manifest URL (contains list of files to download)
 */
export function getModelManifestUrl(modelSpec: WebLLMModelSpec): string {
  return getModelFileUrl(modelSpec, 'mlc-chat-config.json');
}

/**
 * Format VRAM requirement for display
 */
export function formatVRAMRequirement(vramGB: number): string {
  return `~${vramGB.toFixed(1)}GB VRAM`;
}

/**
 * Get model display info for UI
 */
export function getModelDisplayInfo(modelSpec: WebLLMModelSpec): {
  name: string;
  description: string;
  vramRequirement: string;
  recommended: boolean;
} {
  const quantName = modelSpec.quantization.toUpperCase();

  // Q4F16 is currently the only available quantization
  // It provides a good balance of speed and quality for tool-calling tasks
  const qualityNote = 'Optimized for tool-calling, uses pre-built Mistral library';

  return {
    name: modelSpec.name,
    description: `${quantName} quantization. ${qualityNote}`,
    vramRequirement: formatVRAMRequirement(modelSpec.vramRequired),
    recommended: true, // Only model available
  };
}
