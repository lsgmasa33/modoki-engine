import type { PluginListenerHandle } from '@capacitor/core';

export interface LoadModelOptions {
  /** Model file path (local filesystem on Android) or URL (web) */
  modelPath: string;
  /** Maximum tokens to generate per response (default: 1024) */
  maxTokens?: number;
  /** Top-K sampling parameter (default: 40) */
  topK?: number;
  /** Temperature for sampling (default: 0.8) */
  temperature?: number;
  /** Random seed for reproducible output */
  randomSeed?: number;
}

export interface SendMessageOptions {
  /** Conversation ID returned by createConversation() */
  conversationId: string;
  /** User message text */
  message: string;
}

export interface TokenReceivedEvent {
  /** Conversation this token belongs to */
  conversationId: string;
  /** The generated token text */
  token: string;
  /** True when generation is complete */
  done: boolean;
}

export interface LoadProgressEvent {
  /** Loading progress from 0 to 1 */
  progress: number;
}

export interface LLMErrorEvent {
  /** Error description */
  message: string;
}

export interface LitertLmPlugin {
  /** Download a model from a URL to local storage. Progress via 'loadProgress' listener. */
  downloadModel(options: {
    url: string;
    filename: string;
  }): Promise<{ ok: boolean; path: string }>;

  /** Check if a model file exists in local storage. */
  isModelDownloaded(options: { filename: string }): Promise<{ exists: boolean; path: string }>;

  /** Load and initialize the LLM engine with a model. */
  loadModel(options: LoadModelOptions): Promise<{ ok: boolean }>;

  /** Get current engine status. */
  getStatus(): Promise<{
    status: 'idle' | 'loading' | 'ready' | 'generating' | 'error';
    modelName: string;
    errorMessage: string;
  }>;

  /** Create a new conversation session (resets history). */
  createConversation(): Promise<{ conversationId: string }>;

  /** Send a message. Tokens arrive via 'tokenReceived' listener. */
  sendMessage(options: SendMessageOptions): Promise<{ ok: boolean }>;

  /** Dispose engine and free all resources. */
  dispose(): Promise<{ ok: boolean }>;

  /** Fired for each generated token during inference. */
  addListener(
    eventName: 'tokenReceived',
    handler: (event: TokenReceivedEvent) => void,
  ): Promise<PluginListenerHandle>;

  /** Fired during model loading to report progress. */
  addListener(
    eventName: 'loadProgress',
    handler: (event: LoadProgressEvent) => void,
  ): Promise<PluginListenerHandle>;

  /** Fired when an error occurs during loading or inference. */
  addListener(
    eventName: 'error',
    handler: (event: LLMErrorEvent) => void,
  ): Promise<PluginListenerHandle>;
}
