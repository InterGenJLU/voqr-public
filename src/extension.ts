import * as vscode from 'vscode';
import { VoicePanel } from './panels/VoicePanel';
import { AudioCapture } from './audio/AudioCapture';
import { SttServerManager } from './server/SttServerManager';
import { TtsServerManager } from './server/TtsServerManager';
import { ChatManager, ModelInfo } from './chat/ChatManager';
import { initLog, log, debug, error, logConfig, logEnvironment, logSessionSummary, perf } from './log';

let audioCapture: AudioCapture | null = null;
let sttServer: SttServerManager | null = null;
let ttsServer: TtsServerManager | null = null;
let chatManager: ChatManager | null = null;
let inputMode: 'pushToTalk' | 'voiceActivity' = 'pushToTalk';
let statusBarItem: vscode.StatusBarItem;

function updateStatusBar(state: 'idle' | 'listening' | 'speaking'): void {
    if (!statusBarItem) {return;}
    switch (state) {
        case 'idle':
            statusBarItem.text = '$(mic) VOQR';
            statusBarItem.tooltip = 'VOQR: Click to start voice input';
            statusBarItem.backgroundColor = undefined;
            break;
        case 'listening':
            statusBarItem.text = '$(mic) VOQR';
            statusBarItem.tooltip = 'VOQR: Listening — click to stop';
            statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
            break;
        case 'speaking':
            statusBarItem.text = '$(unmute) VOQR';
            statusBarItem.tooltip = 'VOQR: Speaking...';
            statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.prominentBackground');
            break;
    }
}

export function activate(context: vscode.ExtensionContext): void {
    const outputChannel = initLog();

    log('Extension activating');
    log(`Extension path: ${context.extensionPath}`);
    logEnvironment();
    logConfig();

    try {
        const MicStream = require('@analyticsinmotion/micstream');
        const ver = MicStream.version();
        log(`micstream ${ver.micstream} loaded (${ver.portaudio})`);
        const devices = MicStream.devices();
        log(`PortAudio input devices: ${devices.length}`);
        for (const d of devices) {
            log(`  [${d.index}] ${d.name} (${d.maxInputChannels}ch @ ${d.defaultSampleRate}Hz${d.isDefault ? ' — DEFAULT' : ''})`);
        }
    } catch (err) {
        error('Failed to load micstream', err);
    }

    try {
        debug('Testing avr-vad import...');
        require('avr-vad');
        debug('avr-vad loaded ok');
    } catch (err) {
        error('Failed to load avr-vad', err);
    }

    // Read input mode from config
    const config = vscode.workspace.getConfiguration('voqr');
    inputMode = config.get<'pushToTalk' | 'voiceActivity'>('inputMode', 'pushToTalk');
    log(`Input mode: ${inputMode}`);

    // Initialize chat manager
    chatManager = new ChatManager({
        onChunk: (text: string) => {
            VoicePanel.sendMessage({ type: 'aiChunk', payload: text });
        },
        onSentence: (sentence: string) => {
            enqueueSentence(sentence);
        },
        onComplete: (_fullResponse: string) => {
            VoicePanel.sendMessage({ type: 'aiComplete', payload: _fullResponse });
            // Flush any remaining fragment buffer — skip if only emoji/whitespace/symbols
            const remaining = fragmentBuffer.trim();
            fragmentBuffer = '';
            // Check if fragment has any actual speakable text (letters or digits)
            if (remaining && /[a-zA-Z0-9]/.test(remaining)) {
                sentenceQueue.push(remaining);
                log(`TTS queue: +1 flushed fragment "${remaining.slice(0, 60)}..."`);
                if (!synthesizing) {
                    processSentenceQueue();
                }
            } else if (remaining) {
                debug(`TTS: discarding non-speakable fragment: "${remaining}"`);
            }
        },
        onError: (message: string) => {
            VoicePanel.sendMessage({ type: 'aiError', payload: message });
        },
        onModelInfo: (name: string, vendor: string) => {
            VoicePanel.sendMessage({ type: 'modelInfo', payload: { name, vendor } });
        },
        onModelListChanged: (models: ModelInfo[], activeId: string | null) => {
            VoicePanel.sendMessage({ type: 'modelList', payload: { models, activeId } });
        },
    });

    // Start TTS server
    ttsServer = new TtsServerManager();
    ttsServer.start().then(() => {
        if (ttsServer?.isReady) {
            log(`TTS server ready at ${ttsServer.serverUrl}`);
        }
    }).catch((err) => {
        error('TTS server startup failed — voice output unavailable', err);
    });

    // Start STT server
    sttServer = new SttServerManager();
    sttServer.start().then(() => {
        if (sttServer?.isReady) {
            log(`STT server ready at ${sttServer.serverUrl}`);
        }
    }).catch((err) => {
        error('STT server startup failed', err);
    });

    const toggleCmd = vscode.commands.registerCommand('voqr.toggleVoicePanel', () => {
        debug('Command: toggleVoicePanel');
        VoicePanel.createOrShow(context);
        chatManager?.refreshModelList();
        syncSettingsToWebview();
    });

    const pttCmd = vscode.commands.registerCommand('voqr.pushToTalk', () => {
        debug('Command: pushToTalk');
        VoicePanel.createOrShow(context);
        syncSettingsToWebview();
        chatManager?.refreshModelList();

        // Don't start mic if no model is selected — let onboarding guide the user
        if (!chatManager?.hasActiveModel) {
            log('Push-to-talk: no model selected — showing panel only');
            return;
        }
        toggleAudioCapture();
    });

    const selectModelCmd = vscode.commands.registerCommand('voqr.selectModel', async (modelId: string) => {
        debug(`Command: selectModel → ${modelId}`);
        if (chatManager) {
            const success = await chatManager.switchModel(modelId);
            if (!success) {
                VoicePanel.sendMessage({ type: 'aiError', payload: `Could not switch to model: ${modelId}` });
            }
        }
    });

    const refreshModelsCmd = vscode.commands.registerCommand('voqr.refreshModels', () => {
        debug('Command: refreshModels');
        chatManager?.refreshModelList();
    });

    const toggleModeCmd = vscode.commands.registerCommand('voqr.toggleInputMode', () => {
        inputMode = inputMode === 'pushToTalk' ? 'voiceActivity' : 'pushToTalk';
        log(`Input mode switched to: ${inputMode}`);
        VoicePanel.sendMessage({ type: 'inputModeChanged', payload: inputMode });

        // If switching to hands-free and mic isn't active, start it
        if (inputMode === 'voiceActivity' && audioCapture && !audioCapture.isActive) {
            log('Hands-free: auto-starting mic');
            audioCapture.start();
            VoicePanel.sendMessage({ type: 'captureStarted' });
            updateStatusBar('listening');
        }
        // If switching to PTT, stop mic (user will manually start)
        if (inputMode === 'pushToTalk' && audioCapture?.isActive) {
            log('Push-to-talk: stopping mic');
            audioCapture.stop();
            VoicePanel.sendMessage({ type: 'captureStopped' });
            updateStatusBar('idle');
        }
    });

    const clearTtsCmd = vscode.commands.registerCommand('voqr.clearTtsQueue', () => {
        log('TTS: mute — clearing queue and stopping playback');
        clearSentenceQueue();
    });

    const wizardReloadCmd = vscode.commands.registerCommand('voqr.wizardReload', (wizardState?: { providerName: string; step: number }) => {
        log(`Wizard: saving state and reloading (provider: ${wizardState?.providerName ?? 'none'}, step: ${wizardState?.step ?? '?'})`);
        context.globalState.update('voqr.wizardReload', wizardState ?? true);
        vscode.commands.executeCommand('workbench.action.reloadWindow');
    });

    // Status bar mic button — always-visible entry point, no keybinding needed
    statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    statusBarItem.command = 'voqr.pushToTalk';
    statusBarItem.text = '$(mic) VOQR';
    statusBarItem.tooltip = 'VOQR: Click to start voice input';
    statusBarItem.show();

    context.subscriptions.push(toggleCmd, pttCmd, selectModelCmd, refreshModelsCmd, toggleModeCmd, clearTtsCmd, wizardReloadCmd, statusBarItem, outputChannel);
    log('Extension activated');

    // If we're coming back from a wizard-triggered reload, auto-open the panel and resume wizard
    const wizardReloadState = context.globalState.get<{ providerName: string; step: number } | boolean>('voqr.wizardReload');
    if (wizardReloadState) {
        context.globalState.update('voqr.wizardReload', undefined);
        log(`Wizard reload detected — auto-opening panel`);
        VoicePanel.createOrShow(context);
        chatManager?.refreshModelList();
        syncSettingsToWebview();

        // Resume wizard at the saved step after a short delay to let the webview initialize
        if (typeof wizardReloadState === 'object' && wizardReloadState.providerName) {
            setTimeout(() => {
                log(`Wizard: resuming ${wizardReloadState.providerName} at step ${wizardReloadState.step}`);
                VoicePanel.sendMessage({ type: 'resumeWizard', payload: wizardReloadState });
            }, 1000);
        }
    }
}

async function toggleAudioCapture(): Promise<void> {
    if (sttServer && !sttServer.isReady) {
        log('STT server not ready yet — waiting...');
        VoicePanel.sendMessage({ type: 'status', payload: 'Starting STT server...' });
        await sttServer.waitUntilReady();
        if (!sttServer.isReady) {
            log('STT server failed to start');
            vscode.window.showErrorMessage('VOQR: STT server failed to start. Check Output panel.');
            return;
        }
    }

    if (!audioCapture) {
        debug('Creating AudioCapture instance');
        audioCapture = new AudioCapture({
            onSpeechStart: () => {
                VoicePanel.sendMessage({ type: 'speechStart' });
            },
            onSpeechEnd: () => {
                VoicePanel.sendMessage({ type: 'speechEnd' });
            },
            onTranscription: (text: string) => {
                // Filter non-speech: Whisper outputs "(upbeat music)", "(silence)", etc.
                // for non-speech audio — drop these instead of sending to AI
                const trimmed = text.trim();
                if (/^\(.*\)$/.test(trimmed) || /^\[.*\]$/.test(trimmed)) {
                    log(`Transcription filtered (non-speech): "${trimmed}"`);
                    return;
                }

                VoicePanel.sendMessage({ type: 'transcription', payload: text });
                log(`Transcription → AI: "${text}"`);

                // Send to AI via Language Model API
                if (chatManager) {
                    chatManager.sendMessage(text);
                }
            },
            onError: (message: string) => {
                VoicePanel.sendMessage({ type: 'error', payload: message });
                vscode.window.showErrorMessage(`VOQR: ${message}`);
            },
            onStatusChange: (status: string) => {
                VoicePanel.sendMessage({ type: 'status', payload: status });
            },
        }, sttServer?.transcribeUrl);
    }

    if (audioCapture.isActive) {
        log('Stopping audio capture');
        audioCapture.stop();
        VoicePanel.sendMessage({ type: 'captureStopped' });
        updateStatusBar('idle');
    } else {
        log('Starting audio capture');
        audioCapture.start();
        VoicePanel.sendMessage({ type: 'captureStarted' });
        updateStatusBar('listening');
    }
}

// ── Streaming TTS synthesis queue ─────────────────────────────────────
// Sentences are enqueued as the LM streams. Each is synthesized and
// played one at a time. The mic is paused during the entire playback
// sequence and resumed after the last sentence finishes.

const sentenceQueue: string[] = [];
let synthesizing = false;
let micPausedForTts = false;
let fragmentBuffer = ''; // accumulates short fragments before enqueueing
const MIN_SENTENCE_LENGTH = 15; // minimum chars to synthesize as a standalone sentence

function syncSettingsToWebview(): void {
    const voqrConfig = vscode.workspace.getConfiguration('voqr');
    const speed = voqrConfig.get<number>('ttsSpeed', 1.0);
    const muted = !voqrConfig.get<boolean>('ttsAutoPlay', true);
    VoicePanel.sendMessage({ type: 'syncSettings', payload: { speed, muted, platform: process.platform } });
    debug(`Settings synced to webview: speed=${speed}, muted=${muted}, platform=${process.platform}`);
}

function clearSentenceQueue(): void {
    sentenceQueue.length = 0;
    fragmentBuffer = '';
    synthesizing = false;
    if (micPausedForTts) {
        micPausedForTts = false;
        if (inputMode === 'voiceActivity') {
            audioCapture?.start();
            VoicePanel.sendMessage({ type: 'captureStarted' });
            VoicePanel.sendMessage({ type: 'status', payload: 'Listening...' });
            updateStatusBar('listening');
        } else {
            VoicePanel.sendMessage({ type: 'status', payload: 'Ready' });
            updateStatusBar('idle');
        }
    }
}

function enqueueSentence(sentence: string): void {
    const voqrConfig = vscode.workspace.getConfiguration('voqr');
    if (!voqrConfig.get<boolean>('ttsAutoPlay', true)) {
        return; // TTS muted
    }
    if (!ttsServer?.isReady) {
        return;
    }

    // Accumulate short fragments (e.g., "2.", "1.") to avoid Kokoro artifacts
    const combined = fragmentBuffer ? fragmentBuffer + ' ' + sentence : sentence;
    if (combined.trim().length < MIN_SENTENCE_LENGTH) {
        fragmentBuffer = combined;
        debug(`TTS: buffering short fragment (${combined.trim().length} chars): "${combined.trim()}"`);
        return;
    }
    fragmentBuffer = '';

    sentenceQueue.push(combined);
    log(`TTS queue: +1 sentence (${sentenceQueue.length} pending) "${combined.slice(0, 60)}..."`);

    // Pause mic on first sentence
    if (!micPausedForTts) {
        const wasListening = audioCapture?.isActive ?? false;
        if (wasListening || inputMode === 'voiceActivity') {
            log('TTS: pausing mic for streaming playback');
            audioCapture?.stop();
            VoicePanel.sendMessage({ type: 'status', payload: 'Speaking...' });
            micPausedForTts = true;
            updateStatusBar('speaking');
        }
    }

    // Start processing if not already running
    if (!synthesizing) {
        processSentenceQueue();
    }
}

async function processSentenceQueue(): Promise<void> {
    synthesizing = true;

    let sentence = sentenceQueue.shift();
    while (sentence) {
        await synthesizeAndPlaySentence(sentence);
        sentence = sentenceQueue.shift();
    }

    synthesizing = false;

    // All sentences played — resume mic
    if (micPausedForTts) {
        micPausedForTts = false;
        if (inputMode === 'voiceActivity') {
            log('TTS: all sentences played — resuming mic');
            audioCapture?.start();
            VoicePanel.sendMessage({ type: 'captureStarted' });
            VoicePanel.sendMessage({ type: 'status', payload: 'Listening...' });
            updateStatusBar('listening');
        } else {
            log('TTS: all sentences played — PTT mode, returning to idle');
            VoicePanel.sendMessage({ type: 'status', payload: 'Ready' });
            updateStatusBar('idle');
        }
    }
}

async function synthesizeAndPlaySentence(text: string): Promise<void> {
    try {
        const voqrConfig = vscode.workspace.getConfiguration('voqr');
        const speed = voqrConfig.get<number>('ttsSpeed', 1.0);

        perf.start('tts_sentence');
        log(`TTS: synthesizing sentence (${text.length} chars): "${text.slice(0, 80)}..."`);

        const synthesizeUrl = ttsServer?.synthesizeUrl;
        if (!synthesizeUrl) {
            return;
        }

        const response = await fetch(synthesizeUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text, speed }),
            signal: AbortSignal.timeout(30000),
        });

        if (!response.ok) {
            throw new Error(`TTS server returned ${response.status}`);
        }

        const wavBuffer = await response.arrayBuffer();
        const latency = perf.end('tts_sentence');

        // Skip empty audio (e.g., emoji-only text that normalizes to nothing)
        if (wavBuffer.byteLength < 1000) {
            debug(`TTS: skipping empty/tiny audio (${wavBuffer.byteLength} bytes)`);
            return;
        }

        // TTS server outputs 48kHz 16-bit mono = 96000 bytes/sec
        const audioDurationMs = (wavBuffer.byteLength / 96000) * 1000;
        log(`TTS: sentence synthesized ${(wavBuffer.byteLength / 1024).toFixed(0)}KB in ${latency.toFixed(0)}ms (${(audioDurationMs / 1000).toFixed(1)}s audio)`);

        // Convert to base64 and play
        const base64 = Buffer.from(wavBuffer).toString('base64');
        const dataUri = `data:audio/wav;base64,${base64}`;
        VoicePanel.sendMessage({ type: 'playAudio', payload: dataUri });

        // Wait for playback to finish before synthesizing next sentence
        await new Promise(resolve => setTimeout(resolve, audioDurationMs + 200));

    } catch (err) {
        const message = err instanceof Error ? err.message : 'TTS failed';
        error(`TTS sentence synthesis failed: ${message}`, err);
        VoicePanel.sendMessage({ type: 'aiError', payload: `Voice output failed: ${message}` });
    }
}

export function deactivate(): void {
    log('Extension deactivating');
    logSessionSummary();
    audioCapture?.destroy();
    audioCapture = null;
    sttServer?.stop();
    sttServer = null;
    ttsServer?.stop();
    ttsServer = null;
    chatManager = null;
    VoicePanel.dispose();
}
