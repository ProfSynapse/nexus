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

/** The command and args of a Nexus `[mcp_servers.<key>]` table, or null when absent. */
export function readCodexMcpServerConfig(content: string, serverKey: string): { command: string; args: string[] } | null {
    const block = findCodexMcpServerBlock(content, serverKey);
    if (!block) {
        return null;
    }

    const body = content.slice(block.start, block.end);
    const command = /^\s*command\s*=\s*"((?:[^"\\]|\\.)*)"/m.exec(body);
    const argsLine = /^\s*args\s*=\s*\[(.*)\]/m.exec(body);
    const args = argsLine
        ? Array.from(argsLine[1].matchAll(/"((?:[^"\\]|\\.)*)"/g), match => unescapeTomlBasicString(match[1]))
        : [];

    return { command: command ? unescapeTomlBasicString(command[1]) : '', args };
}

/**
 * Replace the Nexus table (header through the line before the next table) with
 * a fresh snippet, or append it when the table is absent.
 */
export function replaceCodexMcpServerConfig(content: string, serverKey: string, snippet: string): string {
    const block = findCodexMcpServerBlock(content, serverKey);
    if (!block) {
        return appendCodexMcpTomlSnippet(content, snippet);
    }

    const before = content.slice(0, block.headerStart);
    const after = content.slice(block.end).replace(/^\n+/, '');
    const rest = after ? `\n${after}` : '';
    return `${before}${snippet.trim()}\n${rest}`;
}

function findCodexMcpServerBlock(content: string, serverKey: string): { headerStart: number; start: number; end: number } | null {
    const tablePattern = new RegExp(
        `^\\s*\\[\\s*mcp_servers\\s*\\.\\s*(?:${escapeRegExp(serverKey)}|"${escapeRegExp(escapeTomlBasicString(serverKey))}")\\s*\\]\\s*$`,
        'm'
    );
    const header = tablePattern.exec(content);
    if (!header) {
        return null;
    }

    const start = header.index + header[0].length;
    const nextTable = /^\s*\[/m.exec(content.slice(start));
    const end = nextTable ? start + nextTable.index : content.length;
    return { headerStart: header.index, start, end };
}

function unescapeTomlBasicString(value: string): string {
    return value.replace(/\\(["\\btnfr])/g, (_match, ch: string) => {
        switch (ch) {
            case 'b': return BACKSPACE;
            case 't': return '\t';
            case 'n': return '\n';
            case 'f': return '\f';
            case 'r': return '\r';
            default: return ch;
        }
    });
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
