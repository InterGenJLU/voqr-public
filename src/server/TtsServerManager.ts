import * as vscode from 'vscode';
import { ChildProcess, spawn } from 'child_process';
import { existsSync } from 'fs';
import * as net from 'net';
import * as path from 'path';
import { log, debug, error, perf } from '../log';
import { SERVER_START_BOUND_MS, waitForStart } from './startWait';

/** After how long a start is called slow, and the person told once that Kokoro is still starting. Measured
 *  starts with the model already on disk took 7.6 to 26.6 s on three machines (2026-11-23). */
const TTS_SLOW_START_MS = 30000;

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

/** The only packages VOQR offers to install, and the only names it accepts from the server's line below. */
const INSTALLABLE_PACKAGES: readonly string[] = ['kokoro', 'aiohttp'];

/** The packages server/tts_server.py names as missing, on a Python that can take them, in its stderr line
 *  "VOQR-MISSING-PACKAGES: kokoro aiohttp". Any name other than kokoro or aiohttp is dropped. */
export function missingPackages(stderr: string): string[] {
    const m = /^VOQR-MISSING-PACKAGES:[ \t]*(.*)$/m.exec(stderr);
    if (!m) {
        return [];
    }
    const named = m[1].trim().split(/\s+/);
    return INSTALLABLE_PACKAGES.filter((p) => named.includes(p));
}

/** The exit code server/tts_server.py gives for its own lasting start-up failures (a package missing or
 *  unloadable, a Python outside 3.10 to 3.12): EX_CONFIG of sysexits.h. Such a failure is the same at every
 *  start, so that server is not restarted; any other exit before it answered may pass, and is tried again. */
export const TTS_EXIT_NOT_CONFIGURED = 78;

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
    /** True while a package install the person asked for runs, so that a second click does not start another. */
    private installing = false;

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
        // Whether the server has said that it is fetching Kokoro's files (its first start), for the slow-start notice.
        let fetching = false;

        proc.stdout?.on('data', (data: Buffer) => {
            debug(`[tts-server stdout] ${data.toString().trim()}`);
        });

        proc.stderr?.on('data', (data: Buffer) => {
            const text = data.toString();
            debug(`[tts-server stderr] ${text.trim()}`);
            stderrTail = (stderrTail + text).slice(-4000);
            if (text.includes('from huggingface.co')) {
                fetching = true;
            }
        });

        proc.on('exit', (code, signal) => {
            log(`TTS: server exited (code=${code}, signal=${signal})`);
            if (this.process !== proc) {
                return; // stopped, or already replaced: nothing to report for this one
            }
            const wasReady = this.ready;
            this.ready = false;
            this.process = null;
            const reason = serverReason(stderrTail);
            // VOQR did not end it (stop() lets go of the process first), so every end is a failure, whatever its
            // code: a signal (the system's out-of-memory killer, for one) or a clean exit included, which would
            // otherwise go untold, as the start wait ends quietly once its process is gone. The server's own
            // lasting failure (a missing package, an unsuitable Python) is the same at every start, so it is not
            // restarted; any other end is tried again, before the server ever answered (a first download that
            // broke) as after.
            const how = signal ? `signal ${signal}` : `exit code ${code}`;
            const lasting = code === TTS_EXIT_NOT_CONFIGURED;
            if (!lasting && this.restartCount < this.maxRestarts) {
                this.restartCount++;
                log(`TTS: restarting (attempt ${this.restartCount}/${this.maxRestarts}) after ${how}${wasReady ? '' : ', it had not yet answered'}${reason ? `; the server said: ${reason}` : ''}`);
                this.startKokoro();
            } else if (!wasReady) {
                error(`TTS: server ended during start-up (${how})${reason ? `: ${reason}` : ''}`);
                const text = reason
                    ? `VOQR: voice output could not start. The TTS server said: ${reason}`
                    : `VOQR: voice output could not start. The TTS server ended (${how}) before it answered.`;
                // A package the server named as missing, on a Python that can take it, is offered for install.
                const packages = lasting ? missingPackages(stderrTail) : [];
                if (packages.length > 0) {
                    const install = `Install ${packages.join(' and ')}`;
                    void vscode.window.showErrorMessage(text, install).then((choice) => {
                        if (choice === install) {
                            void this.installPackages(pythonParts, packages);
                        }
                    });
                } else {
                    vscode.window.showErrorMessage(text);
                }
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

        await this.waitForHealth(proc, () => fetching);
    }

    /** Waits for the server started as proc to answer, for as long as proc runs, because Kokoro's first start
     *  downloads its model; the person is told once when it is slow, told again if it has still not answered after
     *  SERVER_START_BOUND_MS, and voice output turns on whenever it answers. It ends quietly once proc has exited,
     *  failed or been stopped, because proc's own handlers have then told the person why. */
    private async waitForHealth(proc: ChildProcess, fetching: () => boolean): Promise<void> {
        const url = `${this.serverUrl}/health`;
        log(`TTS: waiting for health at ${url}`);

        let toldSlow = false;
        const { outcome, checks } = await waitForStart({
            url,
            alive: () => this.process === proc,
            boundMs: SERVER_START_BOUND_MS,
            slowAfterMs: TTS_SLOW_START_MS,
            onSlow: () => {
                toldSlow = true;
                const downloading = fetching();
                log(`TTS: still starting after ${TTS_SLOW_START_MS / 1000} s${downloading ? ', downloading Kokoro files' : ''}; waiting while the server runs`);
                vscode.window.showInformationMessage(downloading
                    ? 'VOQR: Kokoro is downloading its model (about 330 MB) for its first start. Voice output begins when it is ready.'
                    : 'VOQR: Kokoro is still starting. Voice output begins when it is ready.');
            },
            onBound: () => {
                toldSlow = true;
                const minutes = SERVER_START_BOUND_MS / 60000;
                error(`TTS: no answer after ${minutes} minutes${fetching() ? ' (Kokoro said it was downloading its files)' : ''}; still waiting while the server runs`);
                vscode.window.showWarningMessage(`VOQR: Kokoro has still not answered after ${minutes} minutes. Voice output begins if it does; to start it again, reload VS Code.`);
            },
        });

        if (outcome === 'ready') {
            const elapsed = perf.end('tts_server_startup', true);
            this.ready = true;
            log(`TTS: server ready (${checks} checks, ${elapsed.toFixed(0)}ms)`);
            if (toldSlow) {
                vscode.window.showInformationMessage('VOQR: voice output is ready.');
            }
            return;
        }
        if (outcome === 'gone') {
            return;
        }
        // Not returned while onBound is given; kept so that no end of the wait is ever silent.
        error(`TTS: server did not answer within ${SERVER_START_BOUND_MS / 60000} minutes`);
        vscode.window.showWarningMessage(`VOQR: the TTS server did not answer within ${SERVER_START_BOUND_MS / 60000} minutes. Voice output is unavailable; reload VS Code to try again.`);
    }

    /** Installs the packages the server named as missing, after the person chose Install on its message: runs
     *  <the Python that ran the server> -m pip install <packages> as a child process (no shell: each argument is
     *  passed as it is) and shows pip's own output in a terminal named "VOQR: install". When pip ends with 0, the
     *  server is started again (its first start may download Kokoro's model, which the start wait covers);
     *  otherwise the person is told, and pip's output stays in that terminal. */
    private async installPackages(pythonParts: string[], packages: string[]): Promise<void> {
        if (this.installing) {
            log('TTS: an install is already running; this request is not started');
            return;
        }
        this.installing = true;
        const args = [...pythonParts.slice(1), '-m', 'pip', 'install', ...packages];
        const shown = [pythonParts[0], ...args].join(' ');
        log(`TTS: installing ${packages.join(' and ')}, as the person chose: ${shown}`);
        const write = new vscode.EventEmitter<string>();
        let outcome: string;
        try {
            outcome = await new Promise<string>((resolve) => {
                let child: ChildProcess | undefined;
                let done = false;
                const end = (how: string): void => {
                    if (!done) {
                        done = true;
                        resolve(how);
                    }
                };
                const toTerminal = (data: Buffer): void => write.fire(data.toString().replace(/\r?\n/g, '\r\n'));
                const pty: vscode.Pseudoterminal = {
                    onDidWrite: write.event,
                    open: () => {
                        write.fire(`VOQR runs: ${shown}\r\n\r\n`);
                        child = spawn(pythonParts[0], args, { stdio: ['ignore', 'pipe', 'pipe'] });
                        child.stdout?.on('data', toTerminal);
                        child.stderr?.on('data', toTerminal);
                        child.on('error', (err) => {
                            write.fire(`\r\n${err.message}\r\n`);
                            end(`could not be run (${err.message})`);
                        });
                        child.on('close', (code, signal) => {
                            write.fire(`\r\npip ended (${signal ? `signal ${signal}` : `exit code ${code}`}).\r\n`);
                            end(code === 0 ? 'ok' : signal ? `ended by signal ${signal}` : `ended with exit code ${code}`);
                        });
                    },
                    close: () => {
                        // The person closed the terminal: pip is stopped with it.
                        if (child && child.exitCode === null && child.signalCode === null) {
                            child.kill();
                        }
                        end('was stopped when its terminal was closed');
                    },
                };
                vscode.window.createTerminal({ name: 'VOQR: install', pty }).show();
            });
        } finally {
            this.installing = false;
        }
        if (outcome === 'ok') {
            log(`TTS: ${packages.join(' and ')} installed; starting the server again`);
            this.restartCount = 0;
            await this.start();
            return;
        }
        error(`TTS: the install of ${packages.join(' and ')} did not finish: pip ${outcome}`);
        vscode.window.showErrorMessage(`VOQR: ${packages.join(' and ')} could not be installed: pip ${outcome}. ` +
            'Its own output is in the terminal "VOQR: install".');
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
