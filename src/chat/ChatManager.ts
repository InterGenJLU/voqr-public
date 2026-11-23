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

/** The text VS Code's built-in Copilot (1.147) throws when an extension asks for a model it keeps for VS Code itself. */
const RESERVED_TO_VS_CODE = /only available to VS Code core/i;

export class ChatManager {
    private model: vscode.LanguageModelChat | null = null;
    /** One model per entry of the list: the one a pick of that entry uses. */
    private availableModels: vscode.LanguageModelChat[] = [];
    /** Each usable model's id, mapped to the id of the list entry it belongs to. */
    private entryOf = new Map<string, string>();
    /** By entry id: the name of an entry that would otherwise read like another entry of its provider. */
    private distinctNames = new Map<string, string>();
    /** Models a provider refused to VOQR because it keeps them for VS Code itself; left off the list this session. */
    private refusedIds = new Set<string>();
    private history: ChatMessage[] = [];
    private events: ChatEvents;

    get hasActiveModel(): boolean {
        return this.model !== null;
    }
    private cancelSource: vscode.CancellationTokenSource | null = null;

    constructor(events: ChatEvents) {
        this.events = events;
        log('ChatManager created');

        // Listen for model availability changes; the model in use stays chosen while it is still offered
        vscode.lm.onDidChangeChatModels(() => {
            debug('Available language models changed — refreshing list');
            this.refreshModelList().catch(err => error('Model list refresh failed', err));
        });
    }

    /** Read the models on offer and rebuild the list. Returns every usable model, routing variants included. */
    private async loadModels(): Promise<vscode.LanguageModelChat[]> {
        const allModels = await vscode.lm.selectChatModels();

        log(`Model discovery: ${allModels.length} raw models from Language Model API`);

        // Filter out broken models (maxTokens < 100)
        const validModels = allModels.filter(m => m.maxInputTokens >= 100);
        log(`  ${allModels.length - validModels.length} models filtered (maxTokens < 100)`);

        // Leave out the models a provider refused earlier in this session because it keeps them for VS Code itself
        const usable = validModels.filter(m => !this.refusedIds.has(m.id));
        if (usable.length < validModels.length) {
            log(`  ${validModels.length - usable.length} models left out (kept by their provider for VS Code itself)`);
        }

        // Merge only the routing variants of one model: one provider, one family, and names that differ only by a
        // "(cheapest)", "(fastest)" or "via <provider>" suffix. An entry uses its variant with the largest context.
        // Models that merely share a display name stay separate entries.
        const groups = new Map<string, vscode.LanguageModelChat[]>();
        for (const m of usable) {
            const key = `${m.vendor}\u0000${m.family}\u0000${this.getBaseModelName(m.name)}`;
            const group = groups.get(key);
            if (group) {
                group.push(m);
            } else {
                groups.set(key, [m]);
            }
        }
        const entries: vscode.LanguageModelChat[][] = [];
        for (const group of groups.values()) {
            const plainNames = group.filter(m => this.getBaseModelName(m.name) === m.name.trim()).length;
            if (plainNames > 1) {
                // Two models with one name, one provider and one family are not routing variants of each other
                for (const m of group) {
                    entries.push([m]);
                }
            } else {
                entries.push(group);
            }
        }
        this.entryOf.clear();
        this.availableModels = entries.map(group => {
            const chosen = group.reduce((best, m) => (m.maxInputTokens > best.maxInputTokens ? m : best));
            for (const m of group) {
                this.entryOf.set(m.id, chosen.id);
            }
            return chosen;
        });

        // Entries of one provider that would read the same get their family added (or their id, when the family
        // is shared too), so the person can tell them apart
        this.distinctNames.clear();
        const byName = new Map<string, vscode.LanguageModelChat[]>();
        for (const m of this.availableModels) {
            const key = `${m.vendor}\u0000${this.plainName(m)}`;
            byName.set(key, [...(byName.get(key) ?? []), m]);
        }
        for (const same of byName.values()) {
            if (same.length < 2) {
                continue;
            }
            for (const m of same) {
                const familyShared = same.filter(o => o.family === m.family).length > 1;
                this.distinctNames.set(m.id, `${this.plainName(m)} (${familyShared ? m.id : m.family})`);
            }
        }

        log(`Model list: ${this.availableModels.length} entries after merging routing variants (from ${allModels.length} raw)`);
        return usable;
    }

    /** Refresh the available models list and notify listeners. */
    async refreshModelList(): Promise<void> {
        const offered = await this.loadModels();

        // Keep the model in use while it is still offered (the provider may hand out a new object for it)
        if (this.model) {
            const inUse = this.model;
            const same = offered.find(m => m.id === inUse.id);
            if (same) {
                this.model = same;
            } else {
                this.model = null;
                log(`Model in use is no longer offered: ${inUse.name} (${inUse.vendor}/${inUse.family}, id ${inUse.id})`);
                this.events.onError(`${inUse.name} is no longer offered by ${this.vendorName(inUse.vendor)}. VOQR will choose a model for your next question, or you can pick one from the model list.`);
            }
        }
        this.sendModelList();
    }

    /** Send the list, and the entry in use, to the panel. */
    private sendModelList(): void {
        const modelInfos = this.availableModels.map(m => this.toModelInfo(m));
        const activeId = this.model ? (this.entryOf.get(this.model.id) ?? null) : null;
        this.events.onModelListChanged(modelInfos, activeId);
    }

    /** Switch to the model of a list entry, by the entry's id. */
    async switchModel(modelId: string): Promise<boolean> {
        log(`switchModel requested: "${modelId}"`);
        log(`Available models and their IDs:`);
        for (const m of this.availableModels) {
            log(`  ID: "${m.id}" → name: "${m.name}" (vendor: ${m.vendor}, family: ${m.family})`);
        }

        const match = this.availableModels.find(m => m.id === modelId);
        if (!match) {
            error(`Model not found: ${modelId}`);
            return false;
        }

        this.model = match;
        log(`Switched to model: ${this.model.name} (${this.model.vendor}/${this.model.family}, id ${this.model.id})`);
        this.events.onModelInfo(this.shownName(this.model), this.model.vendor);
        return true;
    }

    /** The name the panel shows for the model in use: its entry's distinct name, else the provider's own name. */
    private shownName(m: vscode.LanguageModelChat): string {
        const entry = this.entryOf.get(m.id);
        return (entry !== undefined ? this.distinctNames.get(entry) : undefined) ?? m.name;
    }

    /** An entry's name before any distinct name: routing suffix removed, and "Auto" with its family. */
    private plainName(m: vscode.LanguageModelChat): string {
        const name = this.getBaseModelName(m.name);
        return name === 'Auto' ? `Auto (${m.family})` : name;
    }

    /** A provider's name for display: "copilot" → "Copilot". */
    private vendorName(vendor: string): string {
        return vendor.charAt(0).toUpperCase() + vendor.slice(1);
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
        return {
            id: m.id,
            name: this.distinctNames.get(m.id) ?? this.plainName(m),
            vendor: this.vendorName(m.vendor),
            family: m.family,
            maxTokens: m.maxInputTokens,
        };
    }

    async selectModel(): Promise<boolean> {
        if (this.model) {return true;}

        debug('Selecting language model...');

        // Refresh available models: the same list the panel shows
        await this.loadModels();

        if (this.availableModels.length === 0) {
            error('No language models available');
            this.events.onModelListChanged([], null);
            this.events.onError(`No AI models available. Sign in to GitHub Copilot (part of recent VS Code), or set up a provider from "+ Add a model" in VOQR's model list.`);
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

        log(`Selected model: ${this.model.name} (${this.model.vendor}/${this.model.family}, id ${this.model.id})`);
        log(`Max input tokens: ${this.model.maxInputTokens}`);
        this.events.onModelInfo(this.shownName(this.model), this.model.vendor);

        // Notify about full model list
        this.sendModelList();
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

            const reason = err instanceof Error ? err.message : String(err);
            if (this.model && RESERVED_TO_VS_CODE.test(reason)) {
                // The provider keeps this model for VS Code itself: take it off the list and say so plainly
                const refused = this.model;
                const name = this.shownName(refused);
                this.refusedIds.add(refused.id);
                this.model = null;
                error(`Model refused: ${refused.name} (${refused.vendor}/${refused.family}, id ${refused.id}): ${reason} Taken off the list for this session.`);
                this.events.onError(`${this.vendorName(refused.vendor)} keeps ${name} for VS Code itself, so VOQR cannot use it. It is now off VOQR's model list; please pick another model.`);
                await this.refreshModelList().catch(e => error('Model list refresh failed', e));
            } else if (err instanceof vscode.LanguageModelError) {
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
