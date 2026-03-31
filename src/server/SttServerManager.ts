import * as vscode from 'vscode';
import { ChildProcess, spawn } from 'child_process';
import { existsSync } from 'fs';
import * as net from 'net';
import { log, debug, error, perf } from '../log';

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

    constructor() {
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

        this.process = spawn(binary, args, {
            stdio: ['ignore', 'pipe', 'pipe'],
        });

        this.process.stdout?.on('data', (data: Buffer) => {
            debug(`[whisper-server stdout] ${data.toString().trim()}`);
        });

        this.process.stderr?.on('data', (data: Buffer) => {
            debug(`[whisper-server stderr] ${data.toString().trim()}`);
        });

        this.process.on('exit', (code, signal) => {
            log(`whisper-server exited (code=${code}, signal=${signal})`);
            this.ready = false;
            this.process = null;

            if (code !== 0 && code !== null && this.restartCount < this.maxRestarts) {
                this.restartCount++;
                log(`Restarting whisper-server (attempt ${this.restartCount}/${this.maxRestarts})`);
                this.startWhisperCpp();
            } else if (code !== 0 && code !== null) {
                error(`whisper-server crashed ${this.maxRestarts} times — giving up`);
                vscode.window.showErrorMessage('VOQR: Speech-to-text server crashed and could not restart. Voice input is unavailable. Try reloading VS Code.');
            }
        });

        this.process.on('error', (err) => {
            error('Failed to spawn whisper-server', err);
            this.process = null;
        });

        await this.waitForHealth();
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

        this.process = spawn(pythonParts[0], args, {
            stdio: ['ignore', 'pipe', 'pipe'],
        });

        this.process.stdout?.on('data', (data: Buffer) => {
            debug(`[faster-whisper stdout] ${data.toString().trim()}`);
        });

        this.process.stderr?.on('data', (data: Buffer) => {
            const line = data.toString().trim();
            debug(`[faster-whisper stderr] ${line}`);
        });

        this.process.on('exit', (code, signal) => {
            log(`faster-whisper server exited (code=${code}, signal=${signal})`);
            this.ready = false;
            this.process = null;

            if (code !== 0 && code !== null && this.restartCount < this.maxRestarts) {
                this.restartCount++;
                log(`Restarting faster-whisper server (attempt ${this.restartCount}/${this.maxRestarts})`);
                this.startFasterWhisper();
            } else if (code !== 0 && code !== null) {
                error(`faster-whisper server crashed ${this.maxRestarts} times — giving up`);
                vscode.window.showErrorMessage('VOQR: Speech-to-text server crashed and could not restart. Voice input is unavailable. Try reloading VS Code.');
            }
        });

        this.process.on('error', (err) => {
            error('Failed to spawn faster-whisper server', err);
            this.process = null;
        });

        await this.waitForHealth();
    }

    private async waitForHealth(): Promise<void> {
        const url = this.healthUrl;
        const maxAttempts = 30;
        const intervalMs = 500;

        log(`Waiting for STT server health at ${url}`);

        for (let i = 0; i < maxAttempts; i++) {
            try {
                const response = await fetch(url);
                if (response.ok) {
                    const elapsed = perf.end('stt_server_startup', true);
                    this.ready = true;
                    log(`STT server ready (${i + 1} health checks, ${elapsed.toFixed(0)}ms)`);
                    return;
                }
            } catch {
                // Server not ready yet
            }

            if (i < maxAttempts - 1) {
                await new Promise(resolve => setTimeout(resolve, intervalMs));
            }
        }

        error(`STT server failed to become healthy after ${maxAttempts} attempts`);
        vscode.window.showErrorMessage('VOQR: STT server failed to start. Check Output panel for details.');
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
        const candidates = [
            `${vscode.extensions.getExtension('intergen.voqr')?.extensionPath ?? '.'}/server/stt_server.py`,
            `${process.cwd()}/server/stt_server.py`,
            `${__dirname}/../../server/stt_server.py`,
        ];

        for (const candidate of candidates) {
            if (existsSync(candidate)) {
                debug(`Found faster-whisper script at: ${candidate}`);
                return candidate;
            }
        }

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
