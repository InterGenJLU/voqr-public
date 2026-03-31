import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

let channel: vscode.OutputChannel | null = null;
let logFd: number | null = null;

// Session metrics
const sessionMetrics = {
    startTime: 0,
    utteranceCount: 0,
    errorCount: 0,
    totalSttLatencyMs: 0,
    totalVadLatencyMs: 0,
    totalEndToEndLatencyMs: 0,
    totalAudioDurationS: 0,
};

// Active timers
const timers = new Map<string, number>();

export function initLog(): vscode.OutputChannel {
    if (!channel) {
        channel = vscode.window.createOutputChannel('VOQR');
    }

    if (logFd === null) {
        const logPath = path.join(__dirname, '..', 'voqr-debug.log');
        logFd = fs.openSync(logPath, 'w');
        writeSync(`=== VOQR Debug Log — ${new Date().toISOString()} ===\n`);
    }

    sessionMetrics.startTime = Date.now();
    return channel;
}

function isDebug(): boolean {
    return vscode.workspace.getConfiguration('voqr').get<boolean>('debug', false);
}

function writeSync(line: string): void {
    if (logFd !== null) {
        fs.writeSync(logFd, line);
    }
}

function emit(level: string, category: string, message: string): void {
    const ts = new Date().toISOString().slice(11, 23);
    const prefix = category ? `[${category}]` : '';
    const line = `[${ts}] ${level} ${prefix} ${message}\n`;
    channel?.appendLine(line.trimEnd());
    writeSync(line);
}

// ── Core logging ────────────────────────────────────────────────────────────

/** Always logged — errors, warnings, key lifecycle events */
export function log(message: string): void {
    emit('INFO', '', message);
}

/** Only logged when voqr.debug is true */
export function debug(message: string): void {
    if (isDebug()) {
        emit('DEBUG', '', message);
    }
}

/** Always logged — errors */
export function error(message: string, err?: unknown): void {
    emit('ERROR', '', message);
    if (err instanceof Error && err.stack) {
        emit('ERROR', '', `Stack: ${err.stack}`);
    }
}

// ── Category logging ────────────────────────────────────────────────────────

export const audio = {
    /** Log audio capture events */
    info(message: string): void {
        emit('INFO', 'audio', message);
    },
    debug(message: string): void {
        if (isDebug()) {
            emit('DEBUG', 'audio', message);
        }
    },
    /** Log audio diagnostics for a chunk of samples */
    diagnostics(samples: Float32Array, label: string): void {
        if (!isDebug()) {return;}
        let sum = 0;
        let peak = 0;
        let silentSamples = 0;
        const silenceThreshold = 0.01;

        for (let i = 0; i < samples.length; i++) {
            const abs = Math.abs(samples[i]);
            sum += samples[i] * samples[i];
            if (abs > peak) {peak = abs;}
            if (abs < silenceThreshold) {silentSamples++;}
        }

        const rms = Math.sqrt(sum / samples.length);
        const silenceRatio = silentSamples / samples.length;
        const durationS = samples.length / 16000;

        emit('DEBUG', 'audio', `${label}: ${samples.length} samples (${durationS.toFixed(2)}s) | RMS=${rms.toFixed(4)} | Peak=${peak.toFixed(4)} | Silence=${(silenceRatio * 100).toFixed(1)}%`);
    },
    error(message: string, err?: unknown): void {
        emit('ERROR', 'audio', message);
        if (err instanceof Error && err.stack) {
            emit('ERROR', 'audio', `Stack: ${err.stack}`);
        }
    },
};

export const vad = {
    info(message: string): void {
        emit('INFO', 'vad', message);
    },
    debug(message: string): void {
        if (isDebug()) {
            emit('DEBUG', 'vad', message);
        }
    },
    /** Log a speech segment detection */
    speechDetected(samples: Float32Array): void {
        const durationS = samples.length / 16000;
        sessionMetrics.totalAudioDurationS += durationS;
        sessionMetrics.utteranceCount++;
        emit('INFO', 'vad', `Speech segment #${sessionMetrics.utteranceCount}: ${samples.length} samples (${durationS.toFixed(2)}s)`);
    },
    error(message: string, err?: unknown): void {
        emit('ERROR', 'vad', message);
        if (err instanceof Error && err.stack) {
            emit('ERROR', 'vad', `Stack: ${err.stack}`);
        }
    },
};

export const stt = {
    info(message: string): void {
        emit('INFO', 'stt', message);
    },
    debug(message: string): void {
        if (isDebug()) {
            emit('DEBUG', 'stt', message);
        }
    },
    /** Log a successful transcription with metrics */
    transcription(text: string, latencyMs: number, audioSizeBytes: number, extra?: {
        language?: string;
        languageProbability?: number;
        serverDuration?: number;
    }): void {
        sessionMetrics.totalSttLatencyMs += latencyMs;
        const details = [
            `latency=${latencyMs}ms`,
            `audio=${(audioSizeBytes / 1024).toFixed(1)}KB`,
        ];
        if (extra?.language) {details.push(`lang=${extra.language}`);}
        if (extra?.languageProbability !== undefined) {details.push(`langProb=${(extra.languageProbability * 100).toFixed(1)}%`);}
        if (extra?.serverDuration !== undefined) {details.push(`serverInference=${(extra.serverDuration * 1000).toFixed(0)}ms`);}

        emit('INFO', 'stt', `Transcription: "${text}" (${details.join(', ')})`);
    },
    error(message: string, err?: unknown): void {
        sessionMetrics.errorCount++;
        emit('ERROR', 'stt', message);
        if (err instanceof Error && err.stack) {
            emit('ERROR', 'stt', `Stack: ${err.stack}`);
        }
    },
};

export const panel = {
    info(message: string): void {
        emit('INFO', 'panel', message);
    },
    debug(message: string): void {
        if (isDebug()) {
            emit('DEBUG', 'panel', message);
        }
    },
    /** Log a message sent to the webview */
    messageSent(type: string, payload?: unknown): void {
        if (isDebug()) {
            const payloadStr = payload !== undefined ? ` payload=${JSON.stringify(payload).slice(0, 100)}` : '';
            emit('DEBUG', 'panel', `Message → webview: ${type}${payloadStr}`);
        }
    },
    /** Log a message received from the webview */
    messageReceived(type: string): void {
        if (isDebug()) {
            emit('DEBUG', 'panel', `Message ← webview: ${type}`);
        }
    },
};

export const perf = {
    /** Start a named timer */
    start(name: string): void {
        timers.set(name, performance.now());
    },
    /** End a named timer, return elapsed ms, optionally log it */
    end(name: string, logResult = true): number {
        const startTime = timers.get(name);
        if (startTime === undefined) {
            emit('WARN', 'perf', `Timer "${name}" was never started`);
            return 0;
        }
        const elapsed = performance.now() - startTime;
        timers.delete(name);

        if (logResult) {
            emit('INFO', 'perf', `${name}: ${elapsed.toFixed(1)}ms`);
        }

        if (name === 'stt_roundtrip') {
            sessionMetrics.totalSttLatencyMs += elapsed;
        } else if (name === 'vad_process') {
            sessionMetrics.totalVadLatencyMs += elapsed;
        } else if (name === 'end_to_end') {
            sessionMetrics.totalEndToEndLatencyMs += elapsed;
        }

        return elapsed;
    },
};

// ── Environment dump ────────────────────────────────────────────────────────

export function logEnvironment(): void {
    const platform = process.platform;
    const home = process.env.HOME ?? process.env.USERPROFILE ?? '(unknown)';

    emit('INFO', 'env', `Platform: ${platform} ${process.arch} | Node: ${process.version}`);
    emit('INFO', 'env', `Home: ${home}`);

    if (platform === 'win32') {
        emit('INFO', 'env', `APPDATA: ${process.env.APPDATA ?? '(not set)'}`);
        emit('INFO', 'env', `LOCALAPPDATA: ${process.env.LOCALAPPDATA ?? '(not set)'}`);
    }

    emit('INFO', 'env', `TEMP: ${process.env.TEMP ?? process.env.TMP ?? '(not set)'}`);

    const pathSep = platform === 'win32' ? ';' : ':';
    const pathEntries = (process.env.PATH ?? '').split(pathSep).filter(p => p.length > 0);
    emit('INFO', 'env', `PATH entries: ${pathEntries.length}`);

    // Check which audio capture tools are available on PATH
    const audioTools = platform === 'win32'
        ? ['sox.exe', 'rec.exe', 'ffmpeg.exe']
        : ['arecord', 'sox', 'rec', 'ffmpeg'];

    for (const tool of audioTools) {
        const found = pathEntries.some(dir => {
            try { return fs.existsSync(path.join(dir, tool)); } catch { return false; }
        });
        emit('INFO', 'env', `  audio tool "${tool}": ${found ? 'found on PATH' : 'not found'}`);
    }
}

// ── Configuration dump ──────────────────────────────────────────────────────

export function logConfig(): void {
    const config = vscode.workspace.getConfiguration('voqr');
    emit('INFO', 'config', `sttServerUrl: ${config.get<string>('sttServerUrl', '(default)')}`);
    emit('INFO', 'config', `ttsServerUrl: ${config.get<string>('ttsServerUrl', '(default)')}`);
    emit('INFO', 'config', `inputMode: ${config.get<string>('inputMode', '(default)')}`);
    emit('INFO', 'config', `debug: ${config.get<boolean>('debug', false)}`);
}

// ── Session summary ─────────────────────────────────────────────────────────

export function logSessionSummary(): void {
    const elapsed = Date.now() - sessionMetrics.startTime;
    const elapsedMin = (elapsed / 60000).toFixed(1);
    const avgSttMs = sessionMetrics.utteranceCount > 0
        ? (sessionMetrics.totalSttLatencyMs / sessionMetrics.utteranceCount).toFixed(0)
        : 'N/A';

    emit('INFO', 'session', '═══ Session Summary ═══');
    emit('INFO', 'session', `Duration: ${elapsedMin} minutes`);
    emit('INFO', 'session', `Utterances: ${sessionMetrics.utteranceCount}`);
    emit('INFO', 'session', `Total audio: ${sessionMetrics.totalAudioDurationS.toFixed(1)}s`);
    emit('INFO', 'session', `Avg STT latency: ${avgSttMs}ms`);
    emit('INFO', 'session', `Errors: ${sessionMetrics.errorCount}`);
    emit('INFO', 'session', '═══════════════════════');
}
