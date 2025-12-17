/**
 * Simple Memory Monitor - Hardcoded Balanced Approach
 * 
 * Provides basic memory monitoring without complex configuration.
 * Uses hardcoded balanced settings as requested by user.
 */

/**
 * Chrome-specific memory API (non-standard)
 * Only available in Chromium-based browsers
 */
interface ChromeMemoryInfo {
  usedJSHeapSize?: number;
  totalJSHeapSize?: number;
  jsHeapSizeLimit?: number;
}

interface PerformanceWithMemory extends Performance {
  memory?: ChromeMemoryInfo;
}

interface MemoryInfo {
  used: number;
  total: number;
  jsHeapSizeLimit?: number;
  usagePercent: number;
}

interface MemoryPressureLevel {
  level: 'normal' | 'warning' | 'high' | 'critical';
  threshold: number;
}

export class SimpleMemoryMonitor {
  private static instance: SimpleMemoryMonitor | null = null;
  private isMonitoring = false;
  private checkInterval: NodeJS.Timeout | null = null;
  
  // Hardcoded balanced thresholds
  private readonly thresholds = {
    warning: 60,   // 60% memory usage
    high: 75,      // 75% memory usage  
    critical: 85   // 85% memory usage
  };

  private constructor() {}

  static getInstance(): SimpleMemoryMonitor {
    if (!SimpleMemoryMonitor.instance) {
      SimpleMemoryMonitor.instance = new SimpleMemoryMonitor();
    }
    return SimpleMemoryMonitor.instance;
  }

  startMonitoring(): void {
    if (this.isMonitoring) return;
    
    this.isMonitoring = true;
    
    // Check memory every 30 seconds
    this.checkInterval = setInterval(() => {
      this.checkMemoryPressure();
    }, 30000);
  }

  stopMonitoring(): void {
    if (!this.isMonitoring) return;
    
    this.isMonitoring = false;
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
    }
  }

  getCurrentMemoryInfo(): MemoryInfo {
    const perfWithMemory = performance as PerformanceWithMemory;
    const memInfo = perfWithMemory.memory;

    if (!memInfo) {
      // Fallback if memory API not available
      return {
        used: 0,
        total: 0,
        usagePercent: 0
      };
    }

    const used = memInfo.usedJSHeapSize || 0;
    const total = memInfo.jsHeapSizeLimit || memInfo.totalJSHeapSize || 0;
    const usagePercent = total > 0 ? (used / total) * 100 : 0;

    return {
      used,
      total,
      jsHeapSizeLimit: memInfo.jsHeapSizeLimit,
      usagePercent
    };
  }

  getPressureLevel(): MemoryPressureLevel {
    const memInfo = this.getCurrentMemoryInfo();
    const usage = memInfo.usagePercent;

    if (usage >= this.thresholds.critical) {
      return { level: 'critical', threshold: this.thresholds.critical };
    } else if (usage >= this.thresholds.high) {
      return { level: 'high', threshold: this.thresholds.high };
    } else if (usage >= this.thresholds.warning) {
      return { level: 'warning', threshold: this.thresholds.warning };
    }
    
    return { level: 'normal', threshold: 0 };
  }

  private checkMemoryPressure(): void {
    const memInfo = this.getCurrentMemoryInfo();
    const pressure = this.getPressureLevel();

    // Log memory stats periodically
    if (pressure.level !== 'normal') {
      const usedMB = Math.round(memInfo.used / (1024 * 1024));
      const totalMB = Math.round(memInfo.total / (1024 * 1024));
      
      
      // Basic cleanup recommendations
      if (pressure.level === 'critical') {
      }
    }
  }

  // Utility method for other services to check if they should perform cleanup
  shouldPerformCleanup(): boolean {
    const pressure = this.getPressureLevel();
    return pressure.level === 'high' || pressure.level === 'critical';
  }

  getMemoryStats(): string {
    const memInfo = this.getCurrentMemoryInfo();
    const pressure = this.getPressureLevel();
    const usedMB = Math.round(memInfo.used / (1024 * 1024));
    const totalMB = Math.round(memInfo.total / (1024 * 1024));
    
    return `Memory: ${usedMB}MB / ${totalMB}MB (${Math.round(memInfo.usagePercent)}%) - ${pressure.level.toUpperCase()}`;
  }
}