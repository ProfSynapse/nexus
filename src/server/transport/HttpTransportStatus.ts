export interface HttpTransportStatus {
    isRunning: boolean;
    disabled: boolean;
    reason: string;
    [key: string]: unknown;
}

export function getDisabledHttpTransportStatus(): HttpTransportStatus {
    return {
        isRunning: false,
        disabled: true,
        reason: 'HTTP MCP transport is disabled; IPC is the supported MCP transport.'
    };
}
