export function buildCodexMcpTomlSnippet(
    serverKey: string,
    command: string,
    args: string[]
): string {
    const escapedArgs = args
        .map((arg) => `"${escapeTomlBasicString(arg)}"`)
        .join(', ');

    return [
        `[mcp_servers.${formatTomlKey(serverKey)}]`,
        `command = "${escapeTomlBasicString(command)}"`,
        `args = [${escapedArgs}]`
    ].join('\n');
}

export function hasCodexMcpServerConfig(content: string, serverKey: string): boolean {
    const tablePattern = new RegExp(
        `^\\s*\\[\\s*mcp_servers\\s*\\.\\s*(?:${escapeRegExp(serverKey)}|"${escapeRegExp(escapeTomlBasicString(serverKey))}")\\s*\\]\\s*$`,
        'm'
    );

    return tablePattern.test(content);
}

export function appendCodexMcpTomlSnippet(content: string, snippet: string): string {
    const trimmedSnippet = snippet.trim();
    if (!content.trim()) {
        return `${trimmedSnippet}\n`;
    }

    const separator = content.endsWith('\n') ? '\n' : '\n\n';
    return `${content}${separator}${trimmedSnippet}\n`;
}

const BACKSPACE = String.fromCharCode(8);

function formatTomlKey(key: string): string {
    if (/^[A-Za-z0-9_-]+$/.test(key)) {
        return key;
    }

    return `"${escapeTomlBasicString(key)}"`;
}

function escapeTomlBasicString(value: string): string {
    return value
        .replace(/\\/g, '\\\\')
        .replace(/"/g, '\\"')
        .replace(new RegExp(BACKSPACE, 'g'), '\\b')
        .replace(/\t/g, '\\t')
        .replace(/\n/g, '\\n')
        .replace(/\f/g, '\\f')
        .replace(/\r/g, '\\r');
}

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
