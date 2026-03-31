/**
 * Speech Chunker
 *
 * Accumulates streamed LLM tokens into speakable sentence chunks.
 * Used by the streaming LLM-to-TTS pipeline.
 *
 * Emits a chunk when:
 *   1. Buffer contains a sentence boundary (. ? ! followed by space/newline)
 *   2. Stream ends (flush remaining buffer)
 *
 * Reference: internal voice pipeline — ported to TypeScript.
 */

const SENTENCE_END = /[.!?]\s/g;

// Common abbreviations whose trailing period is NOT a sentence boundary
const ABBREVIATIONS = new Set([
    'dr', 'mr', 'mrs', 'ms', 'jr', 'sr', 'st', 'vs', 'etc', 'prof',
    'gen', 'gov', 'sgt', 'lt', 'col', 'capt', 'rev',
    'approx', 'dept', 'est', 'inc', 'corp', 'ave',
    'min', 'max', 'avg', 'num', 'config', 'doc', 'docs',
]);

export class SpeechChunker {
    private buffer = '';

    /** Check if the word immediately before the dot is an abbreviation. */
    private isAbbreviation(textBeforeDot: string): boolean {
        const trimmed = textBeforeDot.trim();
        if (!trimmed) {
            return false;
        }
        const parts = trimmed.split(/\s+/);
        const lastWord = parts[parts.length - 1].toLowerCase().replace(/\.$/, '');
        return ABBREVIATIONS.has(lastWord);
    }

    /** Feed a token. Returns a speakable chunk if one is ready, else null. */
    feed(token: string): string | null {
        this.buffer += token;

        // Find the first real sentence boundary (skip abbreviation periods)
        SENTENCE_END.lastIndex = 0;
        let match: RegExpExecArray | null;
        while ((match = SENTENCE_END.exec(this.buffer)) !== null) {
            if (this.buffer[match.index] === '.' && this.isAbbreviation(this.buffer.slice(0, match.index))) {
                continue;
            }
            const splitPos = match.index + match[0].length;
            const chunk = this.buffer.slice(0, splitPos).trim();
            this.buffer = this.buffer.slice(splitPos);
            if (chunk) {
                return chunk;
            }
        }

        return null;
    }

    /** Flush any remaining buffered text. */
    flush(): string | null {
        const chunk = this.buffer.trim();
        this.buffer = '';
        return chunk || null;
    }

    /** Reset the chunker state. */
    reset(): void {
        this.buffer = '';
    }
}
