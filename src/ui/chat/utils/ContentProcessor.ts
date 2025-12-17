/**
 * ContentProcessor - Handles content formatting, escaping, and processing utilities
 */

export class ContentProcessor {
  /**
   * Escape HTML for safe display
   */
  static escapeHtml(text: string): string {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  /**
   * Unescape HTML entities
   */
  static unescapeHtml(html: string): string {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    return doc.body.textContent || '';
  }

  /**
   * Process markdown content for display (basic implementation)
   */
  static processMarkdown(content: string): string {
    // Simple markdown processing - can be enhanced later
    let processed = content;
    
    // Code blocks
    processed = processed.replace(/```(\w*)\n([\s\S]*?)```/g, '<pre><code class="language-$1">$2</code></pre>');
    
    // Inline code
    processed = processed.replace(/`([^`]+)`/g, '<code>$1</code>');
    
    // Bold
    processed = processed.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    
    // Italic
    processed = processed.replace(/\*([^*]+)\*/g, '<em>$1</em>');
    
    // Headers
    processed = processed.replace(/^### (.*$)/gim, '<h3>$1</h3>');
    processed = processed.replace(/^## (.*$)/gim, '<h2>$1</h2>');
    processed = processed.replace(/^# (.*$)/gim, '<h1>$1</h1>');
    
    // Lists
    processed = processed.replace(/^[\s]*\* (.+)$/gm, '<li>$1</li>');
    processed = processed.replace(/^[\s]*- (.+)$/gm, '<li>$1</li>');
    
    // Wrap consecutive list items in ul tags  
    processed = processed.replace(/(<li>.*<\/li>)/g, '<ul>$1</ul>');
    
    // Line breaks
    processed = processed.replace(/\n/g, '<br>');
    
    return processed;
  }

  /**
   * Sanitize content to prevent XSS
   */
  static sanitizeContent(content: string): string {
    // Remove potentially dangerous tags and attributes
    const dangerous = /<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi;
    let sanitized = content.replace(dangerous, '');
    
    // Remove javascript: and data: URLs
    sanitized = sanitized.replace(/javascript:/gi, '');
    sanitized = sanitized.replace(/data:/gi, '');
    
    // Remove on* event handlers
    sanitized = sanitized.replace(/on\w+\s*=/gi, '');
    
    return sanitized;
  }

  /**
   * Truncate text to specified length with ellipsis
   */
  static truncateText(text: string, maxLength: number, ellipsis: string = '...'): string {
    if (text.length <= maxLength) {
      return text;
    }
    
    return text.substring(0, maxLength - ellipsis.length) + ellipsis;
  }

  /**
   * Extract plain text from HTML content
   */
  static extractPlainText(html: string): string {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    return doc.body.textContent || '';
  }

  /**
   * Format conversation preview text
   */
  static formatConversationPreview(lastMessage: string, maxLength: number = 100): string {
    // Remove markdown formatting for preview
    let preview = lastMessage
      .replace(/```[\s\S]*?```/g, '[code block]') // Replace code blocks
      .replace(/`([^`]+)`/g, '$1') // Remove inline code backticks
      .replace(/\*\*([^*]+)\*\*/g, '$1') // Remove bold
      .replace(/\*([^*]+)\*/g, '$1') // Remove italic
      .replace(/^#+\s*/gm, '') // Remove headers
      .replace(/^\s*[-*]\s*/gm, '') // Remove list markers
      .replace(/\n+/g, ' ') // Replace newlines with spaces
      .trim();
    
    return this.truncateText(preview, maxLength);
  }

  /**
   * Validate and clean message content
   */
  static cleanMessageContent(content: string): string {
    // Trim whitespace
    let cleaned = content.trim();
    
    // Remove excessive whitespace
    cleaned = cleaned.replace(/\s+/g, ' ');
    
    // Remove null bytes
    cleaned = cleaned.replace(/\0/g, '');
    
    return cleaned;
  }

  /**
   * Check if content is safe for display
   */
  static isContentSafe(content: string): boolean {
    // Check for dangerous patterns
    const dangerousPatterns = [
      /<script/i,
      /javascript:/i,
      /data:text\/html/i,
      /vbscript:/i,
      /on\w+\s*=/i
    ];
    
    return !dangerousPatterns.some(pattern => pattern.test(content));
  }

  /**
   * Format file size for display
   */
  static formatFileSize(bytes: number): string {
    if (bytes === 0) return '0 B';
    
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
  }
}