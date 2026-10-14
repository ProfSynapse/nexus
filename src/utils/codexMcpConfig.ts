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
 * Point the Nexus `[mcp_servers.<key>]` table at `command` and `args`, or
 * append a fresh table when there is none.
 *
 * Only the `command` and `args` values change. Every other key in the table
 * (env, startup_timeout_sec, tool_timeout_sec, enabled, enabled_tools...) and
 * every comment stay exactly as the user wrote them.
 */
export function upsertCodexMcpServerConfig(content: string, serverKey: string, command: string, args: string[]): string {
    const block = findCodexMcpServerBlock(content, serverKey);
    if (!block) {
        return appendCodexMcpTomlSnippet(content, buildCodexMcpTomlSnippet(serverKey, command, args));
    }

    const argsValue = `[${args.map((arg) => `"${escapeTomlBasicString(arg)}"`).join(', ')}]`;
    let body = content.slice(block.start, block.end);
    // args first, so a missing command is inserted above it.
    body = setTomlValue(body, 'args', argsValue);
    body = setTomlValue(body, 'command', `"${escapeTomlBasicString(command)}"`);
    return `${content.slice(0, block.start)}${body}${content.slice(block.end)}`;
}

function findCodexMcpServerBlock(content: string, serverKey: string): { start: number; end: number } | null {
    const tablePattern = new RegExp(
        `^\\s*\\[\\s*mcp_servers\\s*\\.\\s*(?:${escapeRegExp(serverKey)}|"${escapeRegExp(escapeTomlBasicString(serverKey))}")\\s*\\]\\s*$`,
        'm'
    );
    const header = tablePattern.exec(content);
    if (!header) {
        return null;
    }

    // The pattern's trailing \s* can run onto the next line; the body starts
    // right after the header's closing bracket.
    const start = header.index + header[0].trimEnd().length;
    const nextTable = /^\s*\[/m.exec(content.slice(start));
    const end = nextTable ? start + nextTable.index : content.length;
    return { start, end };
}

/**
 * Replace the value of `key = ...` in a table body, keeping its indentation
 * and any trailing comment, or insert the line right after the header.
 */
function setTomlValue(body: string, key: string, value: string): string {
    const line = new RegExp(`^([ \\t]*)${escapeRegExp(key)}[ \\t]*=[ \\t]*`, 'm').exec(body);
    if (!line) {
        return `\n${key} = ${value}${body}`;
    }
    const valueStart = line.index + line[0].length;
    const valueEnd = tomlValueEnd(body, valueStart);
    return `${body.slice(0, valueStart)}${value}${body.slice(valueEnd)}`;
}

/**
 * Where a TOML value that starts at `from` ends: past the closing bracket of
 * an array or inline table (which may span lines), otherwise before the end of
 * the line or a trailing comment. Strings are skipped so brackets, quotes and
 * `#` inside them do not count.
 */
function tomlValueEnd(text: string, from: number): number {
    let depth = 0;
    let i = from;
    while (i < text.length) {
        const ch = text[i];
        if (ch === '"' || ch === "'") {
            i = skipTomlString(text, i);
            continue;
        }
        if (ch === '#') {
            if (depth === 0) {
                return trimEndIndex(text, from, i);
            }
            const newline = text.indexOf('\n', i);
            i = newline === -1 ? text.length : newline;
            continue;
        }
        if (ch === '[' || ch === '{') {
            depth++;
        } else if (ch === ']' || ch === '}') {
            depth--;
            if (depth <= 0) {
                return i + 1;
            }
        } else if (ch === '\n' && depth === 0) {
            return trimEndIndex(text, from, i);
        }
        i++;
    }
    return trimEndIndex(text, from, text.length);
}

/** Index just past a single-line basic ("...") or literal ('...') string that opens at `at`. */
function skipTomlString(text: string, at: number): number {
    const quote = text[at];
    let i = at + 1;
    while (i < text.length && text[i] !== quote && text[i] !== '\n') {
        i += quote === '"' && text[i] === '\\' ? 2 : 1;
    }
    return i + 1;
}

function trimEndIndex(text: string, from: number, end: number): number {
    let i = end;
    while (i > from && (text[i - 1] === ' ' || text[i - 1] === '\t' || text[i - 1] === '\r')) {
        i--;
    }
    return i;
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
