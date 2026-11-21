import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import type { RealTimeVAD } from 'avr-vad';
import { audio, vad, stt, perf, error } from '../log';

/** Microsoft's download page for the Visual C++ Redistributable. */
export const VC_REDIST_PAGE = 'https://learn.microsoft.com/cpp/windows/latest-supported-vc-redist';

// onnxruntime-node's Windows binaries import these Visual C++ runtime files, which the
// redistributable installs in System32. A clean Windows does not have them.
const VC_RUNTIME_FILES = ['msvcp140.dll', 'msvcp140_1.dll', 'vcruntime140.dll', 'vcruntime140_1.dll'];

/** The Visual C++ runtime files missing from System32. Always empty outside Windows. */
export function missingVcRuntime(): string[] {
    if (process.platform !== 'win32') {
        return [];
    }
    const system32 = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32');
    return VC_RUNTIME_FILES.filter((name) => !fs.existsSync(path.join(system32, name)));
}

/** The voice-activity model could not load because the Visual C++ runtime is missing. */
export class VcRuntimeMissingError extends Error {}

/**
 * Loads the voice-activity model's module. avr-vad loads onnxruntime's native code, so it is
 * loaded on first use and never when the extension loads: a native module that cannot load
 * must not stop activation. If the Visual C++ runtime is missing, the error says what to install.
 */
export function loadVad(): typeof RealTimeVAD {
    try {
        return (require('avr-vad') as typeof import('avr-vad')).RealTimeVAD;
    } catch (err) {
        // A native module whose own DLLs are missing fails to load with ERR_DLOPEN_FAILED; only
        // then can the missing runtime files be the cause. Any other failure, such as a missing
        // or wrong-platform binary (MODULE_NOT_FOUND), is passed on as it is.
        const dlopenFailed = err instanceof Error && (err as NodeJS.ErrnoException).code === 'ERR_DLOPEN_FAILED';
        const missing = dlopenFailed ? missingVcRuntime() : [];
        if (missing.length > 0) {
            throw new VcRuntimeMissingError(
                'Voice input needs the Microsoft Visual C++ Redistributable (x64). ' +
                `These files are missing from System32: ${missing.join(', ')}. ` +
                `Download it from ${VC_REDIST_PAGE}, then reload the window.`,
                { cause: err },
            );
        }
        throw err;
    }
}

// node-record-lpcm16 and micstream are CommonJS modules without types
 
const record = require('node-record-lpcm16');

interface AudioCaptureEvents {
    onSpeechStart: () => void;
    onSpeechEnd: (audio: Float32Array) => void;
    onTranscription: (text: string) => void;
    onError: (message: string) => void;
    onStatusChange: (status: string) => void;
}

interface ActiveRecording {
    stream: NodeJS.ReadableStream;
    stop: () => void;
}

export class AudioCapture {
    private recording: ActiveRecording | null = null;
    private vadInstance: RealTimeVAD | null = null;
    private active = false;
    private events: AudioCaptureEvents;
    private sttUrl: string;
    private frameCount = 0;

    constructor(events: AudioCaptureEvents, sttTranscribeUrl?: string) {
        this.events = events;
        this.sttUrl = sttTranscribeUrl
            ?? vscode.workspace.getConfiguration('voqr').get<string>('sttServerUrl', 'http://127.0.0.1:8099') + '/transcribe';
        audio.info(`AudioCapture created — STT endpoint: ${this.sttUrl}`);
    }

    get isActive(): boolean {
        return this.active;
    }

    async start(): Promise<void> {
        if (this.active) {
            audio.debug('start() called but already active');
            return;
        }

        try {
            perf.start('audio_startup');
            this.events.onStatusChange('Loading VAD...');

            if (!this.vadInstance) {
                perf.start('vad_init');
                vad.info('Initializing Silero VAD...');
                this.vadInstance = await loadVad().new({
                    onSpeechStart: () => {
                        vad.debug('Speech start detected');
                        this.events.onStatusChange('Hearing speech...');
                        this.events.onSpeechStart();
                    },
                    onSpeechEnd: (speechAudio: Float32Array) => {
                        vad.speechDetected(speechAudio);
                        audio.diagnostics(speechAudio, 'Speech segment');
                        this.events.onStatusChange('Processing...');
                        this.events.onSpeechEnd(speechAudio);
                        this.sendToSTT(speechAudio);
                    },
                    onVADMisfire: () => {
                        vad.debug('Misfire (segment too short)');
                        this.events.onStatusChange('Listening...');
                    },
                    onFrameProcessed: () => {},
                    onSpeechRealStart: () => {
                        vad.debug('Speech confirmed (real start)');
                    },
                });
                perf.end('vad_init');
            }

            vad.info('Starting VAD');
            this.vadInstance.start();

            this.events.onStatusChange('Opening microphone...');
            this.recording = this.openMic();
            this.frameCount = 0;

            const stream = this.recording.stream;
            audio.info(`Stream type: ${typeof stream}, readable: ${(stream as NodeJS.ReadableStream).readable}`);

            // Force flowing mode — ensure data events fire
            stream.resume();

            stream.on('data', (chunk: Buffer) => {
                try {
                    if (!this.active || !this.vadInstance) {return;}
                    this.frameCount++;

                    // Convert S16_LE to Float32 for VAD
                    const int16 = new Int16Array(
                        chunk.buffer,
                        chunk.byteOffset,
                        chunk.length / 2,
                    );
                    const float32 = new Float32Array(int16.length);
                    for (let i = 0; i < int16.length; i++) {
                        float32[i] = int16[i] / 32768;
                    }

                    if (this.frameCount <= 3) {
                        audio.debug(`Chunk #${this.frameCount}: ${chunk.length} bytes → ${float32.length} samples`);
                        audio.diagnostics(float32, `Chunk #${this.frameCount}`);
                    } else if (this.frameCount % 500 === 0) {
                        audio.debug(`Chunk #${this.frameCount} (periodic check)`);
                        audio.diagnostics(float32, `Chunk #${this.frameCount}`);
                    }

                    this.vadInstance.processAudio(float32);
                } catch (err) {
                    audio.error(`Error in audio callback #${this.frameCount}`, err);
                }
            });

            stream.on('error', (err: Error) => {
                // When we intentionally stop the mic (e.g. TTS pause), killing
                // the arecord process triggers a stream error. Don't alarm the user.
                if (!this.active) {
                    audio.debug('Mic stream error after stop (expected)');
                    return;
                }
                audio.error('Mic stream error', err);
                this.events.onError(`Microphone error: ${err?.message ?? 'unknown'}`);
                this.stop();
            });

            stream.on('end', () => audio.debug('Mic stream ended'));
            stream.on('close', () => audio.debug('Mic stream closed'));

            // Set active BEFORE audio starts flowing — data handler checks this flag
            this.active = true;
            audio.info(`active=true, frameCount=${this.frameCount}, vadInstance=${!!this.vadInstance}`);
            perf.end('audio_startup');
            audio.info('Microphone open — listening');
            this.events.onStatusChange('Listening...');
        } catch (err) {
            const message = err instanceof Error ? err.message : 'Failed to start audio capture';
            error(`Audio capture startup failed: ${message}`, err);
            this.events.onError(message);
            this.events.onStatusChange('Mic error');
            this.stop();
        }
    }

    stop(): void {
        audio.info(`Stopping (active=${this.active}, totalFrames=${this.frameCount})`);
        this.active = false;

        if (this.recording) {
            audio.debug('Stopping mic capture');
            this.recording.stop();
            this.recording = null;
        }

        if (this.vadInstance) {
            vad.debug('Pausing VAD');
            this.vadInstance.pause();
        }

        this.events.onStatusChange('Ready');
    }

    destroy(): void {
        audio.info('Destroying AudioCapture');
        this.stop();
        if (this.vadInstance) {
            this.vadInstance.destroy();
            this.vadInstance = null;
            vad.debug('VAD destroyed');
        }
    }

    private openMic(): ActiveRecording {
        const platform = process.platform;

        if (platform === 'linux') {
            // Linux: arecord subprocess (proven stable; micstream segfaults on Linux)
            audio.info('Mic backend: arecord subprocess (linux, 16kHz mono S16_LE)');
            const rec = record.record({
                sampleRate: 16000,
                channels: 1,
                recorder: 'arecord',
                audioType: 'raw',
            });
            return { stream: rec.stream(), stop: () => rec.stop() };
        }

        // Windows / macOS: micstream via PortAudio (pre-built native module)
        audio.info(`Mic backend: micstream/PortAudio (${platform})`);
         
        const MicStream = require('@analyticsinmotion/micstream');

        // Log available devices so logs show exactly what PortAudio sees
        try {
            const devices: Array<{ index: number; name: string; maxInputChannels: number; defaultSampleRate: number; isDefault: boolean }> = MicStream.devices();
            audio.info(`PortAudio input devices: ${devices.length}`);
            for (const d of devices) {
                audio.info(`  [${d.index}] ${d.name} (${d.maxInputChannels}ch @ ${d.defaultSampleRate}Hz${d.isDefault ? ' — DEFAULT' : ''})`);
            }
        } catch (err) {
            audio.error('Failed to enumerate PortAudio devices', err);
        }

        const mic = new MicStream({ sampleRate: 16000, channels: 1, format: 'int16' });
        mic.on('backpressure', () => audio.debug('micstream backpressure — consumer too slow'));
        audio.info('micstream capture opened (16kHz mono int16)');

        return { stream: mic, stop: () => mic.stop() };
    }

    private async sendToSTT(samples: Float32Array): Promise<void> {
        perf.start('stt_roundtrip');
        const wavBuffer = float32ToWav(samples, 16000);
        const audioSizeBytes = wavBuffer.byteLength;
        stt.debug(`Sending ${samples.length} samples (${(audioSizeBytes / 1024).toFixed(1)}KB) to ${this.sttUrl}`);

        try {
            const formData = new FormData();
            // whisper.cpp expects 'file', faster-whisper expects 'audio' — use 'file' as it works with both
            formData.append('file', new Blob([wavBuffer], { type: 'audio/wav' }), 'recording.wav');
            formData.append('response_format', 'json');

            const response = await fetch(this.sttUrl, {
                method: 'POST',
                body: formData,
                signal: AbortSignal.timeout(15000), // 15s timeout
            });

            if (!response.ok) {
                throw new Error(`STT server returned ${response.status}`);
            }

            const result = await response.json() as {
                text: string;
                language?: string;
                language_probability?: number;
                duration?: number;
            };
            const latencyMs = perf.end('stt_roundtrip', false);
            const text = (result.text ?? '').trim();

            if (text) {
                stt.transcription(text, latencyMs, audioSizeBytes, {
                    language: result.language,
                    languageProbability: result.language_probability,
                    serverDuration: result.duration,
                });
                this.events.onTranscription(text);
            } else {
                stt.debug(`Empty transcription (latency=${latencyMs.toFixed(0)}ms)`);
            }

            if (this.active) {
                this.events.onStatusChange('Listening...');
            }
        } catch (err) {
            perf.end('stt_roundtrip', false);
            const message = err instanceof Error ? err.message : 'STT request failed';
            stt.error(message, err);
            this.events.onError(`STT error: ${message}`);
            if (this.active) {
                this.events.onStatusChange('STT error — check server');
            }
        }
    }
}

function float32ToWav(samples: Float32Array, sampleRate: number): ArrayBuffer {
    const numChannels = 1;
    const bitsPerSample = 16;
    const byteRate = sampleRate * numChannels * (bitsPerSample / 8);
    const blockAlign = numChannels * (bitsPerSample / 8);
    const dataSize = samples.length * (bitsPerSample / 8);
    const buffer = new ArrayBuffer(44 + dataSize);
    const view = new DataView(buffer);

    function writeString(offset: number, str: string): void {
        for (let i = 0; i < str.length; i++) {
            view.setUint8(offset + i, str.charCodeAt(i));
        }
    }

    writeString(0, 'RIFF');
    view.setUint32(4, 36 + dataSize, true);
    writeString(8, 'WAVE');
    writeString(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, numChannels, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, byteRate, true);
    view.setUint16(32, blockAlign, true);
    view.setUint16(34, bitsPerSample, true);
    writeString(36, 'data');
    view.setUint32(40, dataSize, true);

    const offset = 44;
    for (let i = 0; i < samples.length; i++) {
        const clamped = Math.max(-1, Math.min(1, samples[i]));
        const int16 = clamped < 0 ? clamped * 0x8000 : clamped * 0x7FFF;
        view.setInt16(offset + i * 2, int16, true);
    }

    return buffer;
}
