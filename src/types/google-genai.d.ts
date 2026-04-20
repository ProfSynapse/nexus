/**
 * Type declarations for @google/genai module
 * This provides basic typing to resolve TypeScript compilation errors
 */

declare module '@google/genai' {
  export type GoogleGenAIRequest = string | Record<string, unknown>;
  export type GoogleGenAIResponse = unknown;

  export interface GenerativeModel {
    generateContent(prompt: GoogleGenAIRequest): Promise<GoogleGenAIResponse>;
    generateContentStream(prompt: GoogleGenAIRequest): AsyncIterable<GoogleGenAIResponse>;
  }

  export interface ModelsAPI {
    generateContent(request: GoogleGenAIRequest): Promise<GoogleGenAIResponse>;
    generateContentStream(request: GoogleGenAIRequest): AsyncIterable<GoogleGenAIResponse>;
  }

  export class GoogleGenAI {
    constructor(options: { apiKey: string });
    getGenerativeModel(options: { model: string }): GenerativeModel;
    models: ModelsAPI;
  }

  export const HarmCategory: unknown;
  export const HarmBlockThreshold: unknown;
  export const GenerativeModel: unknown;
}
