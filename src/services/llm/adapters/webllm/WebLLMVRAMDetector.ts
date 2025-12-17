/**
 * WebLLMVRAMDetector
 *
 * Single Responsibility: Detect WebGPU availability and estimate VRAM capacity.
 * Used to determine if WebLLM can run and which quantization levels are supported.
 *
 * ╔═══════════════════════════════════════════════════════════════════════════╗
 * ║  PLATFORM SUPPORT                                                          ║
 * ╠═══════════════════════════════════════════════════════════════════════════╣
 * ║  - macOS (Apple Silicon): Works natively via Metal                        ║
 * ║  - Windows (NVIDIA/AMD): Requires updated GPU drivers + Vulkan support    ║
 * ║  - Linux: Requires Vulkan support                                         ║
 * ║                                                                            ║
 * ║  TROUBLESHOOTING WINDOWS + NVIDIA:                                         ║
 * ║  1. Update NVIDIA drivers to latest version (needs Vulkan support)        ║
 * ║  2. Ensure Obsidian is up-to-date (needs recent Electron with WebGPU)     ║
 * ║  3. Check chrome://gpu in Obsidian DevTools for WebGPU status             ║
 * ║  4. Try enabling chrome://flags/#enable-unsafe-webgpu if available        ║
 * ╚═══════════════════════════════════════════════════════════════════════════╝
 */

import { VRAMInfo } from './types';

// ============================================================================
// WebGPU Type Definitions
// ============================================================================

/**
 * WebGPU adapter info interface
 * Provides GPU hardware information
 */
interface GPUAdapterInfo {
  vendor?: string;
  architecture?: string;
  device?: string;
  description?: string;
}

/**
 * WebGPU adapter interface
 * Represents a physical GPU available to the system
 */
interface GPUAdapter {
  readonly info?: GPUAdapterInfo;
  readonly limits: GPUSupportedLimits;
  requestAdapterInfo?(): Promise<GPUAdapterInfo>;
  requestDevice(): Promise<GPUDevice>;
}

/**
 * WebGPU supported limits interface
 */
interface GPUSupportedLimits {
  readonly maxBufferSize: number;
  // Additional limits exist but maxBufferSize is what we need for VRAM estimation
}

/**
 * WebGPU device interface
 */
interface GPUDevice {
  readonly limits: GPUSupportedLimits;
  destroy(): void;
}

/**
 * WebGPU API interface
 */
interface GPU {
  requestAdapter(options?: { powerPreference?: 'low-power' | 'high-performance' }): Promise<GPUAdapter | null>;
}

/**
 * Extended Navigator interface with WebGPU support
 */
interface NavigatorGPU extends Navigator {
  readonly gpu: GPU;
}

/**
 * Type guard to check if navigator has WebGPU support
 */
function hasGPU(navigator: Navigator): navigator is NavigatorGPU {
  return 'gpu' in navigator;
}

export class WebLLMVRAMDetector {
  private static cachedInfo: VRAMInfo | null = null;

  /**
   * Check if WebGPU is available in the current environment
   */
  static async isWebGPUAvailable(): Promise<boolean> {
    if (typeof navigator === 'undefined') {
      return false;
    }

    if (!hasGPU(navigator)) {
      return false;
    }

    try {
      const gpu = navigator.gpu;

      // Try different adapter options for better compatibility
      // Windows/NVIDIA may need explicit high-performance preference
      let adapter = await gpu.requestAdapter({ powerPreference: 'high-performance' });

      if (!adapter) {
        // Fallback: try without power preference
        adapter = await gpu.requestAdapter();
      }

      return !!adapter;
    } catch (error) {
      return false;
    }
  }

  /**
   * Detect VRAM and GPU capabilities
   * Results are cached after first detection
   */
  static async detect(): Promise<VRAMInfo> {
    // Return cached result if available
    if (this.cachedInfo) {
      return this.cachedInfo;
    }

    const info: VRAMInfo = {
      available: false,
      estimatedVRAM: 0,
      recommendedQuantizations: [],
      webGPUSupported: false,
    };

    // Check WebGPU support
    if (typeof navigator === 'undefined' || !hasGPU(navigator)) {
      this.cachedInfo = info;
      return info;
    }

    try {
      const gpu = navigator.gpu;

      // Request high-performance adapter first (important for Windows/NVIDIA)
      let adapter = await gpu.requestAdapter({ powerPreference: 'high-performance' });

      if (!adapter) {
        // Fallback to default adapter
        adapter = await gpu.requestAdapter();
      }

      if (!adapter) {
        this.cachedInfo = info;
        return info;
      }

      info.webGPUSupported = true;
      info.available = true;

      // Get adapter info for GPU name
      // Note: requestAdapterInfo() was deprecated, use adapter.info property instead
      let gpuDescription = 'Unknown GPU';
      try {
        // New API: adapter.info is a synchronous property
        if (adapter.info) {
          gpuDescription = adapter.info.description || adapter.info.device || adapter.info.vendor || 'Unknown GPU';
        } else if (typeof adapter.requestAdapterInfo === 'function') {
          // Fallback to old API for older implementations
          const adapterInfo = await adapter.requestAdapterInfo();
          gpuDescription = adapterInfo.description || adapterInfo.device || 'Unknown GPU';
        }
      } catch (infoError) {
        // Ignore error getting adapter info
      }
      info.gpuName = gpuDescription;

      // Request device to get limits
      const device = await adapter.requestDevice();

      // Estimate VRAM from maxBufferSize
      // This is not exact but gives a reasonable approximation
      const maxBufferSize = device.limits.maxBufferSize;
      const estimatedVRAM = maxBufferSize / (1024 * 1024 * 1024); // Convert to GB

      // Apply heuristics based on known GPU patterns
      info.estimatedVRAM = this.refineVRAMEstimate(estimatedVRAM, info.gpuName || 'Unknown GPU');

      // Determine recommended quantizations based on VRAM
      info.recommendedQuantizations = this.getRecommendedQuantizations(info.estimatedVRAM);

      // Clean up
      device.destroy();

      this.cachedInfo = info;
      return info;
    } catch (error) {
      this.cachedInfo = info;
      return info;
    }
  }

  /**
   * Refine VRAM estimate using GPU name heuristics
   */
  private static refineVRAMEstimate(rawEstimate: number, gpuName: string): number {
    const lowerName = gpuName.toLowerCase();

    // Known VRAM amounts for common GPUs
    const knownGPUs: Record<string, number> = {
      // NVIDIA RTX 40 series
      '4090': 24,
      '4080': 16,
      '4070 ti super': 16,
      '4070 ti': 12,
      '4070 super': 12,
      '4070': 12,
      '4060 ti': 8,
      '4060': 8,
      // NVIDIA RTX 30 series
      '3090': 24,
      '3080 ti': 12,
      '3080': 10,
      '3070 ti': 8,
      '3070': 8,
      '3060 ti': 8,
      '3060': 12,
      // Apple Silicon (unified memory - these are typical configurations)
      // Order matters: more specific patterns must come before base patterns
      'm1 ultra': 64,
      'm1 max': 32,
      'm1 pro': 16,
      'm1': 8,
      'm2 ultra': 64,
      'm2 max': 32,
      'm2 pro': 16,
      'm2': 8,
      'm3 max': 36,
      'm3 pro': 18,
      'm3': 8,
      'm4 max': 48,
      'm4 pro': 24,
      'm4': 16, // Base M4 typically 16GB or 24GB (user has 24GB)
      // AMD
      '7900 xtx': 24,
      '7900 xt': 20,
      '7800 xt': 16,
      '7700 xt': 12,
      '6900 xt': 16,
      '6800 xt': 16,
    };

    // Check if GPU name matches any known pattern
    for (const [pattern, vram] of Object.entries(knownGPUs)) {
      if (lowerName.includes(pattern)) {
        return vram;
      }
    }

    // Default Apple Silicon detection (unified memory)
    if (lowerName.includes('apple') || lowerName.includes('m1') || lowerName.includes('m2') || lowerName.includes('m3') || lowerName.includes('m4')) {
      // Apple Silicon can use more of unified memory
      // Conservative estimate: 75% of system memory for ML
      return Math.max(rawEstimate, 8); // Assume at least 8GB unified
    }

    // Integrated Intel/AMD graphics
    if (lowerName.includes('intel') || lowerName.includes('integrated')) {
      return Math.min(rawEstimate, 4); // Cap at 4GB for integrated
    }

    // Use raw estimate with a conservative multiplier
    // maxBufferSize often underestimates true VRAM
    return Math.max(rawEstimate * 1.5, 4);
  }

  /**
   * Get recommended quantization levels based on available VRAM
   *
   * Mistral 7B VRAM requirements:
   * - Q4F16: ~5GB
   * - Q5F16: ~5.5GB
   * - Q8F16: ~7GB
   */
  private static getRecommendedQuantizations(vramGB: number): ('q4f16' | 'q5f16' | 'q8f16')[] {
    const recommendations: ('q4f16' | 'q5f16' | 'q8f16')[] = [];

    // Add buffer for OS and other applications (1-2GB)
    const effectiveVRAM = vramGB - 1.5;

    if (effectiveVRAM >= 7) {
      recommendations.push('q8f16');
    }

    if (effectiveVRAM >= 5.5) {
      recommendations.push('q5f16');
    }

    if (effectiveVRAM >= 5) {
      recommendations.push('q4f16');
    }

    return recommendations;
  }

  /**
   * Get human-readable VRAM status message
   */
  static getStatusMessage(info: VRAMInfo): string {
    if (!info.webGPUSupported) {
      return 'WebGPU is not supported in your browser. WebLLM requires WebGPU for GPU-accelerated inference.';
    }

    if (info.recommendedQuantizations.length === 0) {
      return `Insufficient VRAM detected (~${info.estimatedVRAM.toFixed(1)}GB). Minimum 5GB required for Q4 quantization.`;
    }

    const quantList = info.recommendedQuantizations.join(', ').toUpperCase();
    return `${info.gpuName || 'GPU'} detected with ~${info.estimatedVRAM.toFixed(1)}GB VRAM. Supported: ${quantList}`;
  }

  /**
   * Clear cached detection results
   * Useful if GPU configuration might have changed
   */
  static clearCache(): void {
    this.cachedInfo = null;
  }
}
