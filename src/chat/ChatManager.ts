import * as vscode from 'vscode';
import { log, debug, error, perf } from '../log';
import { SpeechChunker } from '../tts/SpeechChunker';

interface ChatMessage {
    role: 'user' | 'assistant';
    content: string;
}

export interface ModelInfo {
    id: string;
    name: string;
    vendor: string;
    family: string;
    maxTokens: number;
}

interface ChatEvents {
    onChunk: (text: string) => void;
    onSentence: (sentence: string) => void;
    onComplete: (fullResponse: string) => void;
    onError: (message: string) => void;
    onModelInfo: (name: string, vendor: string) => void;
    onModelListChanged: (models: ModelInfo[], activeId: string | null) => void;
}

export class ChatManager {
    private model: vscode.LanguageModelChat | null = null;
    private availableModels: vscode.LanguageModelChat[] = [];
    private history: ChatMessage[] = [];
    private events: ChatEvents;

    get hasActiveModel(): boolean {
        return this.model !== null;
    }
    private cancelSource: vscode.CancellationTokenSource | null = null;

    constructor(events: ChatEvents) {
        this.events = events;
        log('ChatManager created');

        // Listen for model availability changes
        vscode.lm.onDidChangeChatModels(() => {
            debug('Available language models changed — refreshing list');
            this.model = null;
            this.refreshModelList();
        });
    }

    /** Refresh the available models list and notify listeners. */
    async refreshModelList(): Promise<void> {
        const allModels = await vscode.lm.selectChatModels();

        log(`Model discovery: ${allModels.length} raw models from Language Model API`);

        // Filter out broken models (maxTokens < 100)
        const validModels = allModels.filter(m => m.maxInputTokens >= 100);
        log(`  ${allModels.length - validModels.length} models filtered (maxTokens < 100)`);

        // Deduplicate: strip "(cheapest)", "(fastest)", "via provider" suffixes
        // Group by base model name, keep the variant with highest maxTokens
        const byBaseName = new Map<string, vscode.LanguageModelChat>();
        for (const m of validModels) {
            const baseName = this.getBaseModelName(m.name);
            const key = `${m.vendor}/${baseName}`;
            const existing = byBaseName.get(key);
            if (!existing || m.maxInputTokens > existing.maxInputTokens) {
                byBaseName.set(key, m);
            }
        }
        this.availableModels = Array.from(byBaseName.values());

        log(`Model list: ${this.availableModels.length} unique models after dedup (from ${allModels.length} raw)`);
        const modelInfos = this.availableModels.map(m => this.toModelInfo(m));
        const activeId = this.model ? this.toModelId(this.model) : null;
        this.events.onModelListChanged(modelInfos, activeId);
    }

    /** Switch to a specific model by ID. */
    async switchModel(modelId: string): Promise<boolean> {
        log(`switchModel requested: "${modelId}"`);
        log(`Available models and their IDs:`);
        for (const m of this.availableModels) {
            log(`  ID: "${this.toModelId(m)}" → name: "${m.name}" (vendor: ${m.vendor}, family: ${m.family})`);
        }

        const match = this.availableModels.find(m => this.toModelId(m) === modelId);
        if (!match) {
            error(`Model not found: ${modelId}`);
            return false;
        }

        this.model = match;
        log(`Switched to model: ${this.model.name} (${this.model.vendor}/${this.model.family})`);
        this.events.onModelInfo(this.model.name, this.model.vendor);
        return true;
    }

    /** Get a stable identifier for a model.
     *  Uses vendor/baseName since some providers (Hugging Face) set the
     *  same family for all models, making vendor/family non-unique.
     */
    private toModelId(m: vscode.LanguageModelChat): string {
        const baseName = this.getBaseModelName(m.name);
        return `${m.vendor}/${baseName}`;
    }

    /** Strip routing suffixes from model names for clean display.
     *  "Qwen/Qwen3-32B (cheapest)" → "Qwen/Qwen3-32B"
     *  "openai/gpt-oss-120b via groq" → "openai/gpt-oss-120b"
     */
    private getBaseModelName(name: string): string {
        return name
            .replace(/\s*\((?:cheapest|fastest)\)\s*$/i, '')
            .replace(/\s+via\s+[\w-]+\s*$/i, '')
            .trim();
    }

    /** Convert a VS Code model to our ModelInfo interface. */
    private toModelInfo(m: vscode.LanguageModelChat): ModelInfo {
        // Clean display name
        let displayName = this.getBaseModelName(m.name);
        if (displayName === 'Auto') {
            displayName = `Auto (${m.family})`;
        }

        // Capitalize vendor for display
        const displayVendor = m.vendor.charAt(0).toUpperCase() + m.vendor.slice(1);

        return {
            id: this.toModelId(m),
            name: displayName,
            vendor: displayVendor,
            family: m.family,
            maxTokens: m.maxInputTokens,
        };
    }

    async selectModel(): Promise<boolean> {
        if (this.model) {return true;}

        debug('Selecting language model...');

        // Refresh available models
        this.availableModels = await vscode.lm.selectChatModels();

        if (this.availableModels.length === 0) {
            error('No language models available');
            this.events.onModelListChanged([], null);
            this.events.onError('No AI models available. Install GitHub Copilot or another language model provider.');
            return false;
        }

        // Prefer larger/better models, fall back to whatever is available
        const preferred = ['gpt-4o', 'gpt-4', 'claude-3.5-sonnet', 'gpt-4o-mini', 'gpt-3.5-turbo'];
        for (const family of preferred) {
            const match = this.availableModels.find(m => m.family === family);
            if (match) {
                this.model = match;
                break;
            }
        }

        // If no preferred match, use the first available
        if (!this.model) {
            this.model = this.availableModels[0];
        }

        log(`Selected model: ${this.model.name} (${this.model.vendor}/${this.model.family})`);
        log(`Max input tokens: ${this.model.maxInputTokens}`);
        this.events.onModelInfo(this.model.name, this.model.vendor);

        // Notify about full model list
        const modelInfos = this.availableModels.map(m => this.toModelInfo(m));
        this.events.onModelListChanged(modelInfos, this.toModelId(this.model));
        return true;
    }

    async sendMessage(userText: string): Promise<void> {
        // Select model if not already done
        const hasModel = await this.selectModel();
        if (!hasModel || !this.model) {return;}

        // Add user message to history
        this.history.push({ role: 'user', content: userText });
        debug(`User message: "${userText}"`);

        // Build message array from history
        const messages = this.history.map(msg =>
            msg.role === 'user'
                ? vscode.LanguageModelChatMessage.User(msg.content)
                : vscode.LanguageModelChatMessage.Assistant(msg.content)
        );

        // Trim history if approaching token limit
        await this.trimHistory(messages);

        // Create cancellation token
        this.cancelSource = new vscode.CancellationTokenSource();

        perf.start('lm_request');

        try {
            const response = await this.model.sendRequest(
                messages,
                {
                    justification: 'VOQR voice chat — responding to user speech',
                },
                this.cancelSource.token,
            );

            // Stream the response — feed tokens to both display and speech chunker
            const chunker = new SpeechChunker();
            let fullResponse = '';
            for await (const chunk of response.text) {
                fullResponse += chunk;
                this.events.onChunk(chunk);

                // Feed to speech chunker — emits complete sentences for TTS
                const sentence = chunker.feed(chunk);
                if (sentence) {
                    this.events.onSentence(sentence);
                }
            }

            // Flush any remaining text in the chunker
            const remaining = chunker.flush();
            if (remaining) {
                this.events.onSentence(remaining);
            }

            const latency = perf.end('lm_request');
            fullResponse = fullResponse.trim();

            // Add assistant response to history
            this.history.push({ role: 'assistant', content: fullResponse });

            log(`LM response (${latency.toFixed(0)}ms): "${fullResponse.slice(0, 100)}${fullResponse.length > 100 ? '...' : ''}"`);
            this.events.onComplete(fullResponse);
        } catch (err) {
            perf.end('lm_request', false);

            if (err instanceof vscode.LanguageModelError) {
                if (err.message.includes('NoPermissions') || err.code === 'NoPermissions') {
                    error('User denied language model permission');
                    this.events.onError('Permission required to use AI. Please approve when prompted.');
                } else if (err.message.includes('Blocked') || err.code === 'Blocked') {
                    error('Language model request blocked (rate limited or quota exceeded)');
                    this.events.onError('AI request was rate limited. Try again in a moment.');
                } else if (err.message.includes('NotFound') || err.code === 'NotFound') {
                    error('Language model no longer available');
                    this.model = null;
                    this.events.onError('AI model is no longer available. Restarting model selection...');
                } else {
                    error(`Language model error: ${err.message}`, err);
                    this.events.onError(`AI error: ${err.message}`);
                }
            } else {
                const message = err instanceof Error ? err.message : 'Unknown error';
                error(`Chat request failed: ${message}`, err);
                this.events.onError(`Chat error: ${message}`);
            }

            // Remove the user message from history since it failed
            this.history.pop();
        } finally {
            this.cancelSource?.dispose();
            this.cancelSource = null;
        }
    }

    cancelRequest(): void {
        if (this.cancelSource) {
            debug('Cancelling LM request');
            this.cancelSource.cancel();
        }
    }

    clearHistory(): void {
        this.history = [];
        debug('Chat history cleared');
    }

    private async trimHistory(messages: vscode.LanguageModelChatMessage[]): Promise<void> {
        if (!this.model) {return;}

        try {
            let totalTokens = 0;
            for (const msg of messages) {
                totalTokens += await this.model.countTokens(msg);
            }

            const budget = this.model.maxInputTokens;
            debug(`Token usage: ${totalTokens}/${budget}`);

            // Keep trimming oldest messages (preserving the latest user message) until under budget
            while (totalTokens > budget * 0.8 && this.history.length > 2) {
                const removed = this.history.shift();
                debug(`Trimmed old message: "${removed?.content.slice(0, 50)}..."`);
                messages.shift();
                totalTokens = 0;
                for (const msg of messages) {
                    totalTokens += await this.model.countTokens(msg);
                }
            }
        } catch {
            // countTokens may not be supported — proceed without trimming
            debug('Token counting not available — skipping history trim');
        }
    }
}
