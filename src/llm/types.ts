import type { Message, ToolCall } from '../session/store.js';
export type { Message, ToolCall };

export interface ToolSchema {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: {
      type: 'object';
      properties: Record<string, any>;
      required?: string[];
    };
  };
}

/** Structured-output constraint handed to the inference server (opt-in). */
export type ResponseFormat =
  | { type: 'json_object' }
  | { type: 'json_schema'; json_schema: { name: string; schema: unknown; strict?: boolean } };

export interface CompletionRequest {
  model: string;
  messages: Message[];
  tools?: ToolSchema[];
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
  /** Tool-selection policy. 'auto' (default) lets the model choose; 'required' forces a
   *  tool call; 'none' forbids tools this turn. Honored by the OpenAI-compatible path. */
  toolChoice?: 'auto' | 'required' | 'none';
  /** Constrain the completion to valid JSON / a JSON Schema. Honored by LM Studio
   *  (response_format) and Ollama (format). Servers that don't support it ignore it. */
  responseFormat?: ResponseFormat;
  /** GBNF grammar for llama.cpp-compatible servers (LM Studio). Forces syntactically
   *  valid output. Ignored by servers that don't accept a `grammar` field. */
  grammar?: string;
  /** Reasoning/thinking effort for models that support it ('low'|'medium'|'high').
   *  Sent as `reasoning_effort` on the OpenAI-compatible path; servers/models that
   *  don't support it ignore the unknown field. Default: unset (model default). */
  reasoningEffort?: 'low' | 'medium' | 'high';
}

export interface StreamEvent {
  type: 'text_delta' | 'tool_call_delta' | 'usage' | 'done' | 'error';
  delta?: string;
  toolCallIndex?: number;
  toolCallId?: string;
  toolName?: string;
  toolArgsDelta?: string;
  usage?: { input: number; output: number };
  error?: string;
}

export interface CompletionResponse {
  content: string;
  toolCalls: ToolCall[];
  usage: { input: number; output: number; costUsd: number };
  finishReason: 'stop' | 'tool_calls' | 'length' | 'error';
  latencyMs: number;
}

export interface ModelInfo {
  id: string;
  contextWindow: number;
  maxOutput: number;
  inputCostPerMillion: number;   // USD
  outputCostPerMillion: number;  // USD
  supportsToolCalls: boolean;
  supportsStreaming: boolean;
}

export abstract class Provider {
  abstract name: string;
  abstract isLocal: boolean;
  abstract listModels(): Promise<ModelInfo[]>;
  abstract complete(req: CompletionRequest): AsyncGenerator<StreamEvent>;
  abstract isAvailable(): Promise<boolean>;
}
