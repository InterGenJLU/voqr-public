import * as vscode from 'vscode';
import { ChildProcess, spawn } from 'child_process';
import { existsSync } from 'fs';
import * as net from 'net';
import { log, debug, error, perf } from '../log';

export class TtsServerManager {
    private process: ChildProcess | null = null;
    private ready = false;
    private port: number;
    private restartCount = 0;
    private maxRestarts = 3;

    constructor() {
        const config = vscode.workspace.getConfiguration('voqr');
        const urlStr = config.get<string>('ttsServerUrl', 'http://127.0.0.1:8100');
        try {
            this.port = new URL(urlStr).port ? parseInt(new URL(urlStr).port, 10) : 8100;
        } catch {
            this.port = 8100;
        }
    }

    get isReady(): boolean {
        return this.ready;
    }

    get serverUrl(): string {
        return `http://127.0.0.1:${this.port}`;
    }

    get synthesizeUrl(): string {
        return `${this.serverUrl}/synthesize`;
    }

    async start(): Promise<void> {
        log('TTS: starting server');

        // Check if port is already in use
        const portInUse = await this.isPortInUse(this.port);
        if (portInUse) {
            log(`TTS: port ${this.port} already in use — checking compatibility`);
            try {
                const response = await fetch(`${this.serverUrl}/health`);
                if (response.ok) {
                    log(`TTS: existing server on port ${this.port} — reusing`);
                    this.ready = true;
                    return;
                }
            } catch {
                // not compatible
            }
            error(`TTS: port ${this.port} occupied by another service`);
            vscode.window.showErrorMessage(`VOQR: TTS port ${this.port} is in use. Change voqr.ttsServerUrl.`);
            return;
        }

        await this.startKokoro();
    }

    private async startKokoro(): Promise<void> {
        const scriptPath = this.resolveScript();
        if (!scriptPath) {
            error('TTS: server script not found');
            vscode.window.showWarningMessage('VOQR: TTS server script not found. Voice output unavailable.');
            return;
        }

        const pythonCmd = await this.findPython();
        if (!pythonCmd) {
            error('TTS: Python3 not found');
            vscode.window.showWarningMessage('VOQR: Python3 required for TTS. Voice output unavailable.');
            return;
        }

        const config = vscode.workspace.getConfiguration('voqr');
        const speed = config.get<number>('ttsSpeed', 1.0);

        log(`TTS: starting Kokoro server (port ${this.port}, speed ${speed})`);
        perf.start('tts_server_startup');

        const pythonParts = pythonCmd.split(' ');
        const args = [
            ...pythonParts.slice(1),
            scriptPath,
            '--port', String(this.port),
            '--speed', String(speed),
        ];

        debug(`TTS command: ${pythonParts[0]} ${args.join(' ')}`);

        this.process = spawn(pythonParts[0], args, {
            stdio: ['ignore', 'pipe', 'pipe'],
        });

        this.process.stdout?.on('data', (data: Buffer) => {
            debug(`[tts-server stdout] ${data.toString().trim()}`);
        });

        this.process.stderr?.on('data', (data: Buffer) => {
            debug(`[tts-server stderr] ${data.toString().trim()}`);
        });

        this.process.on('exit', (code, signal) => {
            log(`TTS: server exited (code=${code}, signal=${signal})`);
            this.ready = false;
            this.process = null;

            if (code !== 0 && code !== null && this.restartCount < this.maxRestarts) {
                this.restartCount++;
                log(`TTS: restarting (attempt ${this.restartCount}/${this.maxRestarts})`);
                this.startKokoro();
            } else if (code !== 0 && code !== null) {
                error(`TTS: server crashed ${this.maxRestarts} times — giving up`);
                vscode.window.showErrorMessage('VOQR: Text-to-speech server crashed and could not restart. Voice output is unavailable. Try reloading VS Code.');
            }
        });

        this.process.on('error', (err) => {
            error('TTS: failed to spawn server', err);
            this.process = null;
        });

        await this.waitForHealth();
    }

    private async waitForHealth(): Promise<void> {
        const url = `${this.serverUrl}/health`;
        const maxAttempts = 60; // Kokoro takes longer to load (~5-10s for model download on first run)
        const intervalMs = 500;

        log(`TTS: waiting for health at ${url}`);

        for (let i = 0; i < maxAttempts; i++) {
            try {
                const response = await fetch(url);
                if (response.ok) {
                    const elapsed = perf.end('tts_server_startup', true);
                    this.ready = true;
                    log(`TTS: server ready (${i + 1} checks, ${elapsed.toFixed(0)}ms)`);
                    return;
                }
            } catch {
                // not ready yet
            }

            if (i < maxAttempts - 1) {
                await new Promise(resolve => setTimeout(resolve, intervalMs));
            }
        }

        error(`TTS: server failed to become healthy after ${maxAttempts} attempts`);
        vscode.window.showWarningMessage('VOQR: TTS server failed to start. Voice output unavailable.');
    }

    async waitUntilReady(timeoutMs = 30000): Promise<void> {
        if (this.ready) {return;}
        const start = Date.now();
        while (Date.now() - start < timeoutMs) {
            if (this.ready) {return;}
            await new Promise(resolve => setTimeout(resolve, 250));
        }
        log(`TTS: waitUntilReady timed out after ${timeoutMs}ms`);
    }

    stop(): void {
        if (this.process) {
            log('TTS: stopping server');
            this.process.kill('SIGTERM');

            const forceKillTimeout = setTimeout(() => {
                if (this.process) {
                    log('TTS: force-killing server (SIGKILL)');
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

    private resolveScript(): string | null {
        const candidates = [
            `${vscode.extensions.getExtension('intergen.voqr')?.extensionPath ?? '.'}/server/tts_server.py`,
            `${process.cwd()}/server/tts_server.py`,
            `${__dirname}/../../server/tts_server.py`,
        ];

        for (const candidate of candidates) {
            if (existsSync(candidate)) {
                debug(`TTS: script found at ${candidate}`);
                return candidate;
            }
        }

        return null;
    }

    private async findPython(): Promise<string | null> {
        // On Windows, try specific minor versions first (3.11-3.13 have ML wheel support).
        // 'py -3.11' uses the Windows Python Launcher to target a specific version.
        // Falls back to generic candidates if no compatible version is found.
        const candidates = process.platform === 'win32'
            ? ['py -3.12', 'py -3.11', 'py -3.13', 'py -3.10', 'py', 'python', 'python3']
            : ['python3', 'python'];

        for (const cmd of candidates) {
            try {
                const parts = cmd.split(' ');
                const proc = spawn(parts[0], [...parts.slice(1), '--version'], { stdio: 'pipe' });
                let versionOutput = '';
                proc.stdout?.on('data', (data: Buffer) => { versionOutput += data.toString(); });
                proc.stderr?.on('data', (data: Buffer) => { versionOutput += data.toString(); });
                const exitCode = await new Promise<number>((resolve) => {
                    proc.on('exit', (code) => resolve(code ?? 1));
                    proc.on('error', () => resolve(1));
                });
                if (exitCode === 0) {
                    const version = versionOutput.trim();
                    log(`TTS: found Python: "${cmd}" → ${version}`);
                    return parts.length > 1 ? cmd : parts[0];
                }
            } catch {
                continue;
            }
        }

        error('TTS: no compatible Python found (need 3.10-3.13 for ML dependencies)');
        return null;
    }

    private isPortInUse(port: number): Promise<boolean> {
        return new Promise((resolve) => {
            const server = net.createServer();
            server.once('error', (err: NodeJS.ErrnoException) => {
                resolve(err.code === 'EADDRINUSE');
            });
            server.once('listening', () => {
                server.close(() => resolve(false));
            });
            server.listen(port, '127.0.0.1');
        });
    }
}
