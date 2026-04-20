export interface IRequestStrategy<TRequest = unknown, TResponse = unknown> {
    canHandle(request: TRequest): boolean;
    handle(request: TRequest): Promise<TResponse>;
}

export interface IRequestStrategyContext {
    agentName?: string;
    mode?: string;
    requestType?: string;
}