/**
 * Type declarations for @google/genai module
 * This provides basic typing to resolve TypeScript compilation errors
 */

declare module '@google/genai' {
  export type GenAIRequest = string | Record<string, unknown>;

  export interface GenerativeModel {
    generateContent(prompt: GenAIRequest): Promise<unknown>;
    generateContentStream(prompt: GenAIRequest): AsyncIterable<unknown>;
  }

  export interface ModelsAPI {
    generateContent(request: Record<string, unknown>): Promise<unknown>;
    generateContentStream(request: Record<string, unknown>): AsyncIterable<unknown>;
    models: ModelsAPI;
  }

  export class GoogleGenAI {
    constructor(options: { apiKey: string });
    getGenerativeModel(options: { model: string }): GenerativeModel;
    models: ModelsAPI;
  }

  export const HarmCategory: Record<string, unknown>;
  export const HarmBlockThreshold: Record<string, unknown>;
}