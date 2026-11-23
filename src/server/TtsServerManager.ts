import * as vscode from 'vscode';
import { ChildProcess, spawn } from 'child_process';
import { existsSync } from 'fs';
import * as net from 'net';
import * as path from 'path';
import { log, debug, error, perf } from '../log';

/** The server's own reason for stopping, read from the end of its stderr: its last "ERROR:" line
 *  without the prefix, else its last line (a Python traceback ends with the exception). */
export function serverReason(stderr: string): string {
    const lines = stderr.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);
    for (let i = lines.length - 1; i >= 0; i--) {
        const m = /^ERROR:\s*(.+)$/.exec(lines[i]);
        if (m) {
            return m[1].slice(0, 300);
        }
    }
    return lines.length ? lines[lines.length - 1].slice(0, 300) : '';
}

/** Exits 0 when this Python can import the TTS server's packages. find_spec locates them without
 *  importing them, so the check takes milliseconds, not the seconds kokoro's own import takes. */
const HAS_TTS_PACKAGES =
    "import importlib.util as u, sys; sys.exit(0 if u.find_spec('kokoro') and u.find_spec('aiohttp') else 3)";

/** How long a Python candidate may take to answer --version or the package check (both take well under a
 *  second on a working Python). */
const PYTHON_PROBE_TIMEOUT_MS = 15000;

export class TtsServerManager {
    private process: ChildProcess | null = null;
    private ready = false;
    private port: number;
    private restartCount = 0;
    private maxRestarts = 3;

    /** extensionPath: the extension's own folder, the only place its server script is looked for. */
    constructor(private readonly extensionPath: string) {
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
            error('TTS: not started, because no Python was found');
            vscode.window.showWarningMessage('VOQR: voice output needs Python 3.10 to 3.12, and no Python was found. Voice output unavailable.');
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

        const proc = spawn(pythonParts[0], args, {
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        this.process = proc;
        // The end of the server's stderr, kept so that its exit can say why in the server's own words.
        let stderrTail = '';

        proc.stdout?.on('data', (data: Buffer) => {
            debug(`[tts-server stdout] ${data.toString().trim()}`);
        });

        proc.stderr?.on('data', (data: Buffer) => {
            const text = data.toString();
            debug(`[tts-server stderr] ${text.trim()}`);
            stderrTail = (stderrTail + text).slice(-4000);
        });

        proc.on('exit', (code, signal) => {
            log(`TTS: server exited (code=${code}, signal=${signal})`);
            if (this.process !== proc) {
                return; // stopped, or already replaced: nothing to report for this one
            }
            const wasReady = this.ready;
            this.ready = false;
            this.process = null;
            if (code === 0 || code === null) {
                return;
            }
            const reason = serverReason(stderrTail);
            if (!wasReady) {
                // It never answered. A missing package or an unsuitable Python fails the same way on every
                // start, so it is not restarted, and the person is told what the server said.
                error(`TTS: server exited during start-up (code=${code})${reason ? `: ${reason}` : ''}`);
                vscode.window.showErrorMessage(reason
                    ? `VOQR: voice output could not start. The TTS server said: ${reason}`
                    : `VOQR: voice output could not start. The TTS server exited with code ${code}.`);
            } else if (this.restartCount < this.maxRestarts) {
                this.restartCount++;
                log(`TTS: restarting (attempt ${this.restartCount}/${this.maxRestarts})${reason ? `; the server said: ${reason}` : ''}`);
                this.startKokoro();
            } else {
                error(`TTS: server crashed ${this.maxRestarts} times — giving up${reason ? `; the server said: ${reason}` : ''}`);
                vscode.window.showErrorMessage('VOQR: Text-to-speech server crashed and could not restart. Voice output is unavailable. ' +
                    `Try reloading VS Code.${reason ? ` The server said: ${reason}` : ''}`);
            }
        });

        proc.on('error', (err) => {
            error('TTS: failed to spawn server', err);
            if (this.process !== proc) {
                return;
            }
            this.process = null;
            vscode.window.showErrorMessage(`VOQR: voice output could not start: ${pythonParts[0]} could not be run (${err.message}).`);
        });

        await this.waitForHealth(proc);
    }

    /** Waits for the server started as proc to answer. It ends quietly once proc has exited, failed or been
     *  stopped, because proc's own handlers have then told the person why. */
    private async waitForHealth(proc: ChildProcess): Promise<void> {
        const url = `${this.serverUrl}/health`;
        const maxAttempts = 60; // Kokoro takes longer to load (~5-10s for model download on first run)
        const intervalMs = 500;

        log(`TTS: waiting for health at ${url}`);

        for (let i = 0; i < maxAttempts; i++) {
            if (this.process !== proc) {
                return;
            }
            try {
                const response = await fetch(url);
                if (response.ok && this.process === proc) {
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

        if (this.process !== proc) {
            return;
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
        // Only the extension's own folder: a script found anywhere else (the working directory, a
        // folder beside the extension) would be code this package did not ship.
        const script = path.join(this.extensionPath, 'server', 'tts_server.py');
        if (existsSync(script)) {
            debug(`TTS: script found at ${script}`);
            return script;
        }
        log(`TTS: script not found at ${script}`);
        return null;
    }

    private async findPython(): Promise<string | null> {
        // Try the minor versions Kokoro installs on first: kokoro 0.9.4 declares Requires-Python
        // >=3.10,<3.13, and the plain python3 is often another version. 'py -3.11' uses the Windows
        // Python Launcher to target a version. Falls back to generic candidates; on an unsuitable
        // version the server says so itself.
        const candidates = process.platform === 'win32'
            ? ['py -3.12', 'py -3.11', 'py -3.10', 'py', 'python', 'python3']
            : ['python3.12', 'python3.11', 'python3.10', 'python3', 'python'];

        // The first candidate that already holds kokoro and aiohttp is taken, whatever its place in
        // the order: a person whose packages live in one interpreter keeps it when another Python is
        // also on the machine. When none holds them, the first that runs is taken, and its server
        // says what is missing.
        let firstThatRuns: string | null = null;
        for (const cmd of candidates) {
            const version = await this.runPython(cmd, ['--version']);
            if (version.code !== 0) {
                continue;
            }
            log(`TTS: found Python: "${cmd}" → ${version.output.trim()}`);
            firstThatRuns ??= cmd;
            const packages = await this.runPython(cmd, ['-c', HAS_TTS_PACKAGES]);
            if (packages.code === 0) {
                log(`TTS: "${cmd}" has kokoro and aiohttp`);
                return cmd;
            }
            debug(`TTS: "${cmd}" does not have both kokoro and aiohttp`);
        }

        if (firstThatRuns) {
            log(`TTS: no Python found with kokoro and aiohttp; using "${firstThatRuns}"`);
            return firstThatRuns;
        }
        error('TTS: no Python found (Kokoro needs Python 3.10 to 3.12)');
        return null;
    }

    /** Runs a Python candidate ("py -3.12" is the launcher with its argument) and collects its output. A
     *  candidate that has not exited within PYTHON_PROBE_TIMEOUT_MS is stopped and counts as not running, so
     *  one that hangs cannot keep voice output from starting without a word. */
    private async runPython(cmd: string, args: string[]): Promise<{ code: number; output: string }> {
        try {
            const parts = cmd.split(' ');
            const proc = spawn(parts[0], [...parts.slice(1), ...args], { stdio: 'pipe' });
            let output = '';
            proc.stdout?.on('data', (data: Buffer) => { output += data.toString(); });
            proc.stderr?.on('data', (data: Buffer) => { output += data.toString(); });
            const code = await new Promise<number>((resolve) => {
                const timer = setTimeout(() => {
                    log(`TTS: "${cmd}" did not answer within ${PYTHON_PROBE_TIMEOUT_MS / 1000} s; skipped`);
                    proc.kill();
                    resolve(124);
                }, PYTHON_PROBE_TIMEOUT_MS);
                proc.on('exit', (exitCode) => { clearTimeout(timer); resolve(exitCode ?? 1); });
                proc.on('error', () => { clearTimeout(timer); resolve(1); });
            });
            return { code, output };
        } catch {
            return { code: 1, output: '' };
        }
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
