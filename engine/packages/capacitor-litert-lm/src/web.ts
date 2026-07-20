import { WebPlugin } from '@capacitor/core';
import type {
  LitertLmPlugin,
  LoadModelOptions,
  SendMessageOptions,
} from './definitions';

// Lazy-loaded MediaPipe types
type LlmInference = import('@mediapipe/tasks-genai').LlmInference;

/** Chat message for building conversation context. */
interface ChatEntry {
  role: 'user' | 'model';
  content: string;
}

/**
 * Web implementation of LitertLm using MediaPipe tasks-genai.
 * Runs Gemma 4 E2B via WebGPU in the browser.
 */
export class LitertLmWeb extends WebPlugin implements LitertLmPlugin {
  private llm: LlmInference | null = null;
  private status: 'idle' | 'loading' | 'ready' | 'generating' | 'error' = 'idle';
  private modelName = '';
  private errorMessage = '';
  private conversations = new Map<string, ChatEntry[]>();
  private nextConversationId = 0;

  async downloadModel(_options: { url: string; filename: string }): Promise<{ ok: boolean; path: string }> {
    // Web doesn't use native download — ModelDownloader.ts handles fetch + Cache API
    return { ok: true, path: '' };
  }

  async isModelDownloaded(_options: { filename: string }): Promise<{ exists: boolean; path: string }> {
    // Web checks Cache API in ModelDownloader.ts, not here
    return { exists: false, path: '' };
  }

  async loadModel(options: LoadModelOptions): Promise<{ ok: boolean }> {
    if (this.status === 'loading') {
      return { ok: false };
    }

    this.status = 'loading';
    this.modelName = options.modelPath.split('/').pop() || 'unknown';
    this.notifyListeners('loadProgress', { progress: 0 });

    try {
      // Lazy-load MediaPipe to avoid bundling it when not on web
      const { FilesetResolver, LlmInference } = await import('@mediapipe/tasks-genai');

      this.notifyListeners('loadProgress', { progress: 0.1 });

      const genai = await FilesetResolver.forGenAiTasks(
        'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-genai/wasm',
      );

      this.notifyListeners('loadProgress', { progress: 0.3 });

      this.llm = await LlmInference.createFromOptions(genai, {
        baseOptions: { modelAssetPath: options.modelPath },
        maxTokens: options.maxTokens ?? 1024,
        topK: options.topK ?? 40,
        temperature: options.temperature ?? 0.8,
        randomSeed: options.randomSeed ?? 0,
      });

      this.status = 'ready';
      this.notifyListeners('loadProgress', { progress: 1 });
      return { ok: true };
    } catch (e) {
      this.status = 'error';
      this.errorMessage = e instanceof Error ? e.message : String(e);
      this.notifyListeners('error', { message: this.errorMessage });
      return { ok: false };
    }
  }

  async getStatus(): Promise<{
    status: 'idle' | 'loading' | 'ready' | 'generating' | 'error';
    modelName: string;
    errorMessage: string;
  }> {
    return {
      status: this.status,
      modelName: this.modelName,
      errorMessage: this.errorMessage,
    };
  }

  async createConversation(): Promise<{ conversationId: string }> {
    const id = String(++this.nextConversationId);
    this.conversations.set(id, []);
    return { conversationId: id };
  }

  async sendMessage(options: SendMessageOptions): Promise<{ ok: boolean }> {
    if (!this.llm || this.status !== 'ready') {
      this.notifyListeners('error', { message: 'Model not loaded' });
      return { ok: false };
    }

    const history = this.conversations.get(options.conversationId);
    if (!history) {
      this.notifyListeners('error', { message: `Unknown conversation: ${options.conversationId}` });
      return { ok: false };
    }

    // Add user message to history
    history.push({ role: 'user', content: options.message });

    // Build Gemma chat prompt from full conversation history
    const prompt = this.buildPrompt(history);

    this.status = 'generating';

    try {
      let fullResponse = '';

      const response = await this.llm.generateResponse(prompt, (partial: string, done: boolean) => {
        // Detect if MediaPipe sends cumulative or individual tokens:
        // If partial starts with fullResponse, it's cumulative — extract delta.
        // Otherwise, partial IS the new token.
        let newToken: string;
        if (partial.startsWith(fullResponse) && partial.length > fullResponse.length) {
          newToken = partial.slice(fullResponse.length);
          fullResponse = partial;
        } else {
          newToken = partial;
          fullResponse += partial;
        }

        if (newToken) {
          this.notifyListeners('tokenReceived', {
            conversationId: options.conversationId,
            token: newToken,
            done: false,
          });
        }

        if (done) {
          this.notifyListeners('tokenReceived', {
            conversationId: options.conversationId,
            token: '',
            done: true,
          });
        }
      });

      // Store assistant response in history
      const finalText = typeof response === 'string' ? response : fullResponse;
      history.push({ role: 'model', content: finalText });

      // Cap history to last 12 entries (6 user + 6 model) to bound memory growth
      const MAX_HISTORY = 12;
      if (history.length > MAX_HISTORY) {
        history.splice(0, history.length - MAX_HISTORY);
      }

      this.status = 'ready';
      return { ok: true };
    } catch (e) {
      this.status = 'error';
      this.errorMessage = e instanceof Error ? e.message : String(e);
      this.notifyListeners('error', { message: this.errorMessage });
      return { ok: false };
    }
  }

  async dispose(): Promise<{ ok: boolean }> {
    if (this.llm) {
      this.llm.close();
      this.llm = null;
    }
    this.conversations.clear();
    this.status = 'idle';
    this.modelName = '';
    this.errorMessage = '';
    return { ok: true };
  }

  /** Build a Gemma 4 chat prompt from conversation history. */
  private buildPrompt(history: ChatEntry[]): string {
    let prompt = '';
    for (const entry of history) {
      prompt += `<|turn>${entry.role}\n${entry.content}<turn|>\n`;
    }
    // Signal the model to generate a response
    prompt += '<|turn>model\n';
    return prompt;
  }
}
