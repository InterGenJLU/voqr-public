/** How long a speech server that VOQR started and that is still running may take to answer its first health check
 *  before the person is told that it has still not answered. Kokoro's first start downloads its model (about
 *  330 MB) and the faster-whisper backend downloads its own, so a start is waited for while its process lives: at
 *  this bound the person is told once, and the wait goes on while the process lives, so that a slow download still
 *  ends in voice in the same session. */
export const SERVER_START_BOUND_MS = 15 * 60 * 1000;

/** How often a server that has passed the bound is asked, so that one that never answers is not asked twice a
 *  second for the rest of the session. */
const AFTER_BOUND_INTERVAL_MS = 5000;

export interface StartWait {
    /** The server's health URL. */
    url: string;
    /** False once the server's process has exited, failed, been stopped or been replaced. */
    alive: () => boolean;
    /** Without onBound: how long to wait in all, while alive() holds. With onBound: when onBound is called. */
    boundMs: number;
    /** Called once when boundMs has passed and alive() still holds; the wait then goes on while alive() holds,
     *  asking every AFTER_BOUND_INTERVAL_MS. Without it, the wait ends when boundMs passes ('bound'). */
    onBound?: () => void;
    /** After how long the person is told, once, that the server is still starting; none if absent. */
    slowAfterMs?: number;
    onSlow?: () => void;
    intervalMs?: number;
}

export type StartOutcome = 'ready' | 'gone' | 'bound';

/** Asks the health URL until it answers ok ('ready') or the process is gone ('gone': its own handlers tell the
 *  person why). Without onBound, the wait also ends when the bound passes ('bound'); with it, the person is told
 *  at the bound and the wait goes on, so it never ends without a word. */
export async function waitForStart(w: StartWait): Promise<{ outcome: StartOutcome; checks: number }> {
    const interval = w.intervalMs ?? 500;
    const started = Date.now();
    let checks = 0;
    let told = false;
    let toldBound = false;
    while (w.onBound || Date.now() - started < w.boundMs) {
        if (!w.alive()) {
            return { outcome: 'gone', checks };
        }
        checks++;
        try {
            const response = await fetch(w.url);
            if (response.ok && w.alive()) {
                return { outcome: 'ready', checks };
            }
        } catch {
            // not answering yet
        }
        const elapsed = Date.now() - started;
        if (!told && !toldBound && w.onSlow && w.slowAfterMs !== undefined && elapsed >= w.slowAfterMs && w.alive()) {
            told = true;
            w.onSlow();
        }
        if (!toldBound && w.onBound && elapsed >= w.boundMs && w.alive()) {
            toldBound = true;
            w.onBound();
        }
        await new Promise((resolve) => setTimeout(resolve, toldBound ? Math.max(interval, AFTER_BOUND_INTERVAL_MS) : interval));
    }
    return { outcome: w.alive() ? 'bound' : 'gone', checks };
}
