import * as vscode from 'vscode';
import { ChildProcess, spawn } from 'child_process';
import { existsSync } from 'fs';
import * as net from 'net';
import * as path from 'path';
import { log, debug, error, perf } from '../log';
import { SERVER_START_BOUND_MS, waitForStart } from './startWait';

/** After how long a start is called slow, and the person told once that speech recognition is still starting.
 *  Measured whisper.cpp starts with the tiny model took 0.7 to 7.1 s (2026-11-23). It is also the whole wait
 *  for an external server, which VOQR does not run. */
const STT_SLOW_START_MS = 15000;

type SttBackend = 'auto' | 'faster-whisper' | 'external';

interface ServerConfig {
    backend: SttBackend;
    modelSize: string;
    whisperCppPath: string;
    whisperModelPath: string;
    port: number;
}

/** Maps backend type to its transcription endpoint path */
const ENDPOINT_MAP: Record<SttBackend, string> = {
    'auto': '/inference',           // whisper.cpp server
    'faster-whisper': '/transcribe', // our Python server
    'external': '/transcribe',       // user's server (default, configurable)
};

export class SttServerManager {
    private process: ChildProcess | null = null;
    private ready = false;
    private config: ServerConfig;
    private restartCount = 0;
    private maxRestarts = 3;

    /** extensionPath: the extension's own folder, the only place its server script is looked for. */
    constructor(private readonly extensionPath: string) {
        this.config = this.loadConfig();
    }

    get isReady(): boolean {
        return this.ready;
    }

    /** Wait for the server to become ready (blocks until healthy or timeout) */
    async waitUntilReady(timeoutMs = 15000): Promise<void> {
        if (this.ready) {return;}
        const start = Date.now();
        while (Date.now() - start < timeoutMs) {
            if (this.ready) {return;}
            await new Promise(resolve => setTimeout(resolve, 250));
        }
        log(`waitUntilReady timed out after ${timeoutMs}ms`);
    }

    get serverUrl(): string {
        if (this.config.backend === 'external') {
            return vscode.workspace.getConfiguration('voqr').get<string>('sttServerUrl', 'http://127.0.0.1:8099');
        }
        return `http://127.0.0.1:${this.config.port}`;
    }

    /** Full URL to the transcription endpoint */
    get transcribeUrl(): string {
        return `${this.serverUrl}${ENDPOINT_MAP[this.config.backend]}`;
    }

    get healthUrl(): string {
        if (this.config.backend === 'auto') {
            // whisper.cpp server doesn't have /health — root returns 200
            return this.serverUrl;
        }
        return `${this.serverUrl}/health`;
    }

    private loadConfig(): ServerConfig {
        const config = vscode.workspace.getConfiguration('voqr');
        const backend = config.get<SttBackend>('sttBackend', 'auto');
        const modelSize = config.get<string>('sttModelSize', 'tiny');
        const whisperCppPath = config.get<string>('whisperCppPath', '');
        const whisperModelPath = config.get<string>('whisperModelPath', '');

        // Parse port from sttServerUrl
        const urlStr = config.get<string>('sttServerUrl', 'http://127.0.0.1:8099');
        let port = 8099;
        try {
            port = new URL(urlStr).port ? parseInt(new URL(urlStr).port, 10) : 8099;
        } catch {
            // keep default
        }

        return { backend, modelSize, whisperCppPath, whisperModelPath, port };
    }

    async start(): Promise<void> {
        this.config = this.loadConfig();
        log(`STT backend: ${this.config.backend}`);

        if (this.config.backend === 'external') {
            log('External STT backend — skipping server management');
            await this.waitForHealth();
            return;
        }

        // Check if port is already in use
        const portInUse = await this.isPortInUse(this.config.port);
        if (portInUse) {
            log(`Port ${this.config.port} is already in use — checking if it's a compatible STT server`);
            try {
                const response = await fetch(this.healthUrl);
                if (response.ok) {
                    log(`Existing STT server found on port ${this.config.port} — reusing it`);
                    this.ready = true;
                    return;
                }
            } catch {
                // Not a compatible server
            }
            error(`Port ${this.config.port} is occupied by another service. Change voqr.sttServerUrl to use a different port.`);
            vscode.window.showErrorMessage(`VOQR: Port ${this.config.port} is already in use. Change the STT server URL in settings.`);
            return;
        }

        if (this.config.backend === 'auto') {
            await this.startWhisperCpp();
        } else if (this.config.backend === 'faster-whisper') {
            await this.startFasterWhisper();
        }
    }

    private isPortInUse(port: number): Promise<boolean> {
        return new Promise((resolve) => {
            const server = net.createServer();
            server.once('error', (err: NodeJS.ErrnoException) => {
                if (err.code === 'EADDRINUSE') {
                    resolve(true);
                } else {
                    resolve(false);
                }
            });
            server.once('listening', () => {
                server.close(() => resolve(false));
            });
            server.listen(port, '127.0.0.1');
        });
    }

    private async startWhisperCpp(): Promise<void> {
        const binary = this.resolveWhisperCppBinary();
        const model = this.resolveWhisperModel();

        if (!binary) {
            error('whisper-server binary not found. Set voqr.whisperCppPath or install whisper.cpp');
            vscode.window.showErrorMessage('VOQR: whisper-server binary not found. Check voqr.whisperCppPath setting.');
            return;
        }

        if (!model) {
            error('Whisper model file not found. Set voqr.whisperModelPath or download a model');
            vscode.window.showErrorMessage('VOQR: Whisper model not found. Check voqr.whisperModelPath setting.');
            return;
        }

        log(`Starting whisper.cpp server: ${binary}`);
        log(`Model: ${model} | Port: ${this.config.port}`);
        perf.start('stt_server_startup');

        const args = [
            '--model', model,
            '--port', String(this.config.port),
            '--host', '127.0.0.1',
        ];

        debug(`Command: ${binary} ${args.join(' ')}`);

        const proc = spawn(binary, args, {
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        this.process = proc;

        this.process.stdout?.on('data', (data: Buffer) => {
            debug(`[whisper-server stdout] ${data.toString().trim()}`);
        });

        this.process.stderr?.on('data', (data: Buffer) => {
            debug(`[whisper-server stderr] ${data.toString().trim()}`);
        });

        this.process.on('exit', (code, signal) => {
            log(`whisper-server exited (code=${code}, signal=${signal})`);
            if (this.process !== proc) {
                return; // stopped (stop() lets go of the process first), or already replaced
            }
            const wasReady = this.ready;
            this.ready = false;
            this.process = null;

            // VOQR did not end it, so every end is a failure, a signal or a clean exit included.
            if (this.restartCount < this.maxRestarts) {
                this.restartCount++;
                log(`Restarting whisper-server (attempt ${this.restartCount}/${this.maxRestarts}) after ${signal ? `signal ${signal}` : `exit code ${code}`}`);
                this.startWhisperCpp();
            } else if (!wasReady) {
                this.reportEndedDuringStart('whisper-server', code, signal);
            } else {
                error(`whisper-server crashed ${this.maxRestarts} times — giving up`);
                vscode.window.showErrorMessage('VOQR: Speech-to-text server crashed and could not restart. Voice input is unavailable. Try reloading VS Code.');
            }
        });

        this.process.on('error', (err) => {
            error('Failed to spawn whisper-server', err);
            if (this.process !== proc) {
                return;
            }
            this.process = null;
            vscode.window.showErrorMessage(`VOQR: voice input could not start: ${binary} could not be run (${err.message}).`);
        });

        await this.waitForHealth(proc);
    }

    private async startFasterWhisper(): Promise<void> {
        const scriptPath = this.resolveFasterWhisperScript();
        if (!scriptPath) {
            error('VOQR STT server script not found');
            vscode.window.showErrorMessage('VOQR: faster-whisper server script not found.');
            return;
        }

        // Check Python is available
        const pythonCmd = await this.findPython();
        if (!pythonCmd) {
            error('Python3 not found — required for faster-whisper backend');
            vscode.window.showErrorMessage('VOQR: Python3 required for faster-whisper backend. Install Python or switch to "auto" backend.');
            return;
        }

        log(`Starting faster-whisper server: ${pythonCmd} ${scriptPath}`);
        log(`Model: ${this.config.modelSize} | Port: ${this.config.port}`);
        perf.start('stt_server_startup');

        const pythonParts = pythonCmd.split(' ');
        const args = [
            ...pythonParts.slice(1),
            scriptPath,
            '--port', String(this.config.port),
            '--model', this.config.modelSize,
            '--device', 'cpu',
            '--compute-type', 'float32',
        ];

        debug(`Command: ${pythonParts[0]} ${args.join(' ')}`);

        const proc = spawn(pythonParts[0], args, {
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        this.process = proc;

        this.process.stdout?.on('data', (data: Buffer) => {
            debug(`[faster-whisper stdout] ${data.toString().trim()}`);
        });

        this.process.stderr?.on('data', (data: Buffer) => {
            const line = data.toString().trim();
            debug(`[faster-whisper stderr] ${line}`);
        });

        this.process.on('exit', (code, signal) => {
            log(`faster-whisper server exited (code=${code}, signal=${signal})`);
            if (this.process !== proc) {
                return; // stopped (stop() lets go of the process first), or already replaced
            }
            const wasReady = this.ready;
            this.ready = false;
            this.process = null;

            // VOQR did not end it, so every end is a failure, a signal or a clean exit included.
            if (this.restartCount < this.maxRestarts) {
                this.restartCount++;
                log(`Restarting faster-whisper server (attempt ${this.restartCount}/${this.maxRestarts}) after ${signal ? `signal ${signal}` : `exit code ${code}`}`);
                this.startFasterWhisper();
            } else if (!wasReady) {
                this.reportEndedDuringStart('faster-whisper server', code, signal);
            } else {
                error(`faster-whisper server crashed ${this.maxRestarts} times — giving up`);
                vscode.window.showErrorMessage('VOQR: Speech-to-text server crashed and could not restart. Voice input is unavailable. Try reloading VS Code.');
            }
        });

        this.process.on('error', (err) => {
            error('Failed to spawn faster-whisper server', err);
            if (this.process !== proc) {
                return;
            }
            this.process = null;
            vscode.window.showErrorMessage(`VOQR: voice input could not start: ${pythonParts[0]} could not be run (${err.message}).`);
        });

        await this.waitForHealth(proc);
    }

    /** Waits for the server to answer. A server this manager started (proc) is waited for while it runs, because
     *  the faster-whisper backend downloads its model at first use; the person is told once when it is slow, told
     *  again if it has still not answered after SERVER_START_BOUND_MS, and voice input turns on whenever it answers.
     *  The wait ends quietly once proc has exited, failed or been stopped, because its own handlers then tell the
     *  person why. An external server is given STT_SLOW_START_MS, as before. */
    private async waitForHealth(proc?: ChildProcess): Promise<void> {
        const url = this.healthUrl;
        log(`Waiting for STT server health at ${url}`);

        let toldSlow = false;
        const { outcome, checks } = await waitForStart(proc ? {
            url,
            alive: () => this.process === proc,
            boundMs: SERVER_START_BOUND_MS,
            slowAfterMs: STT_SLOW_START_MS,
            onSlow: () => {
                toldSlow = true;
                log(`STT server still starting after ${STT_SLOW_START_MS / 1000} s; waiting while it runs`);
                vscode.window.showInformationMessage('VOQR: speech recognition is still starting. Voice input begins when it is ready.');
            },
            onBound: () => {
                toldSlow = true;
                const minutes = SERVER_START_BOUND_MS / 60000;
                error(`STT server: no answer after ${minutes} minutes; still waiting while it runs`);
                vscode.window.showWarningMessage(`VOQR: speech recognition has still not answered after ${minutes} minutes. Voice input begins if it does; to start it again, reload VS Code.`);
            },
        } : { url, alive: () => true, boundMs: STT_SLOW_START_MS });

        if (outcome === 'ready') {
            const elapsed = perf.end('stt_server_startup', true);
            this.ready = true;
            log(`STT server ready (${checks} health checks, ${elapsed.toFixed(0)}ms)`);
            if (toldSlow) {
                vscode.window.showInformationMessage('VOQR: voice input is ready.');
            }
            return;
        }
        if (outcome === 'gone') {
            return;
        }
        // An external server (no proc) given STT_SLOW_START_MS; a server VOQR started is waited for while it runs.
        error(`STT server did not answer within ${proc ? `${SERVER_START_BOUND_MS / 60000} minutes` : `${STT_SLOW_START_MS / 1000} s`}`);
        vscode.window.showErrorMessage('VOQR: STT server failed to start. Check Output panel for details.');
    }

    /** A server VOQR started ended before it ever answered, VOQR did not stop it, and its restarts are spent. The
     *  start wait ends quietly once the process is gone, so this is the only word the person gets. */
    private reportEndedDuringStart(name: string, code: number | null, signal: NodeJS.Signals | null): void {
        const how = signal ? `signal ${signal}` : `exit code ${code}`;
        error(`${name} ended during start-up (${how})`);
        vscode.window.showErrorMessage(`VOQR: voice input could not start: the speech-to-text server ended (${how}) before it answered.`);
    }

    stop(): void {
        if (this.process) {
            log('Stopping STT server');
            this.process.kill('SIGTERM');

            // Force kill after 3 seconds if still running
            const forceKillTimeout = setTimeout(() => {
                if (this.process) {
                    log('Force-killing STT server (SIGKILL)');
                    this.process.kill('SIGKILL');
                }
            }, 3000);

            this.process.on('exit', () => {
                clearTimeout(forceKillTimeout);
            });

            this.process = null;
        }
        this.ready = false;
    }

    private resolveWhisperCppBinary(): string | null {
        // 1. User-configured path
        if (this.config.whisperCppPath) {
            const exists = existsSync(this.config.whisperCppPath);
            log(`whisper-server configured path: ${this.config.whisperCppPath} — ${exists ? 'found' : 'NOT FOUND'}`);
            if (exists) {return this.config.whisperCppPath;}
        }

        // 2. Known locations, platform-specific
        const home = process.env.HOME ?? process.env.USERPROFILE ?? '';
        const isWin = process.platform === 'win32';
        const exe = isWin ? 'whisper-server.exe' : 'whisper-server';

        const candidates = isWin ? [
            `${home}\\whisper.cpp\\bin\\${exe}`,
            `${home}\\whisper.cpp\\build\\bin\\${exe}`,
            `${home}\\whisper.cpp\\build\\bin\\Release\\${exe}`,
            `C:\\Program Files\\whisper.cpp\\${exe}`,
            `C:\\whisper.cpp\\build\\bin\\${exe}`,
        ] : [
            `${home}/whisper.cpp/build/bin/${exe}`,
            `/usr/local/bin/${exe}`,
            `/usr/bin/${exe}`,
        ];

        for (const candidate of candidates) {
            const exists = existsSync(candidate);
            debug(`whisper-server candidate: ${candidate} — ${exists ? 'FOUND' : 'not found'}`);
            if (exists) {
                log(`whisper-server found: ${candidate}`);
                return candidate;
            }
        }

        log(`whisper-server not found in ${candidates.length} candidate locations — set voqr.whisperCppPath`);
        return null;
    }

    private resolveWhisperModel(): string | null {
        // 1. User-configured path
        if (this.config.whisperModelPath) {
            const exists = existsSync(this.config.whisperModelPath);
            log(`whisper model configured path: ${this.config.whisperModelPath} — ${exists ? 'found' : 'NOT FOUND'}`);
            if (exists) {return this.config.whisperModelPath;}
        }

        // 2. Known locations, platform-specific
        const home = process.env.HOME ?? process.env.USERPROFILE ?? '';
        const modelName = `ggml-${this.config.modelSize}.bin`;

        const candidates = process.platform === 'win32' ? [
            `${home}\\whisper.cpp\\models\\${modelName}`,
            `${process.env.APPDATA}\\whisper\\${modelName}`,
            `${process.env.LOCALAPPDATA}\\whisper\\${modelName}`,
        ] : [
            `${home}/whisper.cpp/models/${modelName}`,
            `${home}/.cache/whisper/${modelName}`,
        ];

        for (const candidate of candidates) {
            const exists = existsSync(candidate);
            debug(`whisper model candidate: ${candidate} — ${exists ? 'FOUND' : 'not found'}`);
            if (exists) {
                log(`whisper model found: ${candidate}`);
                return candidate;
            }
        }

        log(`whisper model "${modelName}" not found in ${candidates.length} candidate locations — set voqr.whisperModelPath`);
        return null;
    }

    private resolveFasterWhisperScript(): string | null {
        // Only the extension's own folder: a script found anywhere else (the working directory, a
        // folder beside the extension) would be code this package did not ship.
        const script = path.join(this.extensionPath, 'server', 'stt_server.py');
        if (existsSync(script)) {
            debug(`Found faster-whisper script at: ${script}`);
            return script;
        }
        log(`faster-whisper script not found at ${script}`);
        return null;
    }

    private async findPython(): Promise<string | null> {
        // 'py' is the Windows Python Launcher — most reliable on Windows
        const candidates = process.platform === 'win32'
            ? ['py', 'python', 'python3']
            : ['python3', 'python'];

        for (const cmd of candidates) {
            try {
                const proc = spawn(cmd, ['--version'], { stdio: 'pipe' });
                const exitCode = await new Promise<number>((resolve) => {
                    proc.on('exit', (code) => resolve(code ?? 1));
                    proc.on('error', () => resolve(1));
                });
                if (exitCode === 0) {
                    debug(`Found Python: ${cmd}`);
                    return cmd;
                }
            } catch {
                continue;
            }
        }

        return null;
    }
}
