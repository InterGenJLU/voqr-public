#!/usr/bin/env python3
"""
VOQR TTS Server — Local text-to-speech via Kokoro.

Usage:
    python3 server/tts_server.py [--port 8100] [--voice-a bm_fable] [--voice-b bm_george] [--blend 0.5] [--speed 1.0]

Accepts POST /synthesize with JSON { "text": "..." }, returns audio/wav.
"""

import argparse
import io
import logging
import re
import sys
import time
import wave
import warnings

import numpy as np

from tts_normalizer import TTSNormalizer

try:
    with warnings.catch_warnings():
        warnings.filterwarnings("ignore", message=".*dropout option adds dropout.*")
        warnings.filterwarnings("ignore", message=".*weight_norm.*is deprecated.*")
        from kokoro import KPipeline
except ImportError:
    print("ERROR: kokoro not installed. Run: pip install kokoro", file=sys.stderr)
    sys.exit(1)

try:
    from aiohttp import web
except ImportError:
    print("ERROR: aiohttp not installed. Run: pip install aiohttp", file=sys.stderr)
    sys.exit(1)

logging.basicConfig(
    level=logging.INFO,
    format="[%(asctime)s] %(levelname)s %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("voqr-tts")

pipeline = None
voice = None
speed = 1.0
sample_rate = 24000   # Kokoro native output rate
output_rate = 48000   # WAV output rate — matches common system rates, avoids browser resampling artifacts
normalizer = TTSNormalizer()


def load_engine(voice_a: str, voice_b: str, blend: float, spd: float):
    """Load Kokoro pipeline and blend voices."""
    global pipeline, voice, speed

    log.info(f"Loading Kokoro TTS pipeline...")
    start = time.monotonic()

    with warnings.catch_warnings():
        warnings.filterwarnings("ignore", message=".*dropout option adds dropout.*")
        warnings.filterwarnings("ignore", message=".*weight_norm.*is deprecated.*")
        pipeline = KPipeline(lang_code='b', repo_id='hexgrad/Kokoro-82M', device='cpu')

    # Load and blend voices
    log.info(f"Blending voices: {voice_a} ({1-blend:.0%}) + {voice_b} ({blend:.0%})")
    va = pipeline.load_voice(voice_a)
    vb = pipeline.load_voice(voice_b)
    voice = (va * (1 - blend)) + (vb * blend)

    speed = spd
    elapsed = time.monotonic() - start
    log.info(f"Kokoro loaded in {elapsed:.2f}s (speed={speed})")


def _trim_trailing_silence(audio_np: np.ndarray, threshold: float = 0.01, keep_ms: int = 150) -> np.ndarray:
    """Trim trailing silence from audio, keeping keep_ms for a natural gap.

    Kokoro appends variable-length silence to each sentence.  Trimming to a
    consistent 150ms tail prevents erratic gaps between back-to-back sentences.
    """
    abs_audio = np.abs(audio_np)
    above = np.where(abs_audio > threshold)[0]
    if len(above) == 0:
        return audio_np
    last_sound = above[-1]
    keep_samples = int(sample_rate * keep_ms / 1000)
    trim_point = min(last_sound + keep_samples, len(audio_np))
    return audio_np[:trim_point]


def _compress_pauses(audio_np: np.ndarray, max_silence_ms: int = 200, threshold: float = 0.015) -> np.ndarray:
    """Cap interior silences to max_silence_ms.

    Kokoro inserts prosodic pauses at clause boundaries (commas, titles, etc.)
    that sound robotic.  This preserves natural prosody but limits how long any
    mid-utterance silence can last.
    """
    window = int(sample_rate * 0.01)  # 10ms analysis window
    max_silence_samples = int(sample_rate * max_silence_ms / 1000)
    n_windows = len(audio_np) // window
    if n_windows < 2:
        return audio_np

    rms = np.array([
        np.sqrt(np.mean(audio_np[i * window:(i + 1) * window] ** 2))
        for i in range(n_windows)
    ])
    voiced = np.where(rms >= threshold)[0]
    if len(voiced) < 2:
        return audio_np
    first_voiced = voiced[0]
    last_voiced = voiced[-1]

    result = [audio_np[:first_voiced * window]]
    silent_run = 0
    for i in range(first_voiced, last_voiced + 1):
        chunk = audio_np[i * window:(i + 1) * window]
        if rms[i] < threshold:
            silent_run += window
            if silent_run <= max_silence_samples:
                result.append(chunk)
        else:
            silent_run = 0
            result.append(chunk)
    result.append(audio_np[(last_voiced + 1) * window:])
    return np.concatenate(result)


def synthesize(text: str, spd: float | None = None) -> bytes:
    """Synthesize text to WAV bytes."""
    use_speed = spd if spd is not None else speed
    chunks = []
    # Dynamic speed: ease off by 5% on long phoneme strings to prevent rushed delivery
    dynamic_speed = lambda ps_len: use_speed if ps_len < 200 else use_speed * 0.95
    for gs, ps, audio in pipeline(text, voice=voice, speed=dynamic_speed):
        chunks.append(np.asarray(audio))

    if not chunks:
        return b""

    full = np.concatenate(chunks)
    # Pause compression disabled — let Kokoro's natural prosodic pauses through.
    # VOQR synthesizes whole paragraphs where structural pauses are needed.
    # full = _compress_pauses(full)
    full = _trim_trailing_silence(full)

    # Upsample from 24kHz to 48kHz — eliminates browser Web Audio resampling artifacts
    if output_rate != sample_rate:
        indices = np.linspace(0, len(full) - 1, len(full) * output_rate // sample_rate)
        full = np.interp(indices, np.arange(len(full)), full)

    # Apply brief fade-in/fade-out to prevent onset/offset transients (internal pattern)
    fade_in_samples = int(output_rate * 0.003)   # 3ms
    fade_out_samples = int(output_rate * 0.003)   # 3ms
    if len(full) > fade_in_samples + fade_out_samples:
        full[:fade_in_samples] *= np.linspace(0.0, 1.0, fade_in_samples)
        full[-fade_out_samples:] *= np.linspace(1.0, 0.0, fade_out_samples)

    int16 = (full * 32767).astype(np.int16)

    buf = io.BytesIO()
    with wave.open(buf, "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(output_rate)
        wf.writeframes(int16.tobytes())

    return buf.getvalue()


async def handle_synthesize(request: web.Request) -> web.Response:
    """POST /synthesize — JSON { text, voice_a?, voice_b?, blend?, speed? } → audio/wav"""
    try:
        data = await request.json()
        text = data.get("text", "").strip()

        if not text:
            return web.json_response({"error": "No text provided"}, status=400)

        # Normalize text for natural speech
        normalized = normalizer.normalize(text)
        if normalized != text:
            log.info(f"Normalized ({len(text)} → {len(normalized)} chars)")
            log.info(f"  Before: \"{text[:100]}{'...' if len(text) > 100 else ''}\"")
            log.info(f"  After:  \"{normalized[:100]}{'...' if len(normalized) > 100 else ''}\"")

        # Read per-request speed override (falls back to server default)
        req_speed = data.get("speed")
        if req_speed is not None:
            req_speed = max(0.5, min(2.0, float(req_speed)))

        log.info(f"Synthesizing ({len(normalized)} chars, speed={req_speed or speed}): \"{normalized[:80]}{'...' if len(normalized) > 80 else ''}\"")

        start = time.monotonic()
        # Strip leading non-speech characters (markdown remnants, ellipsis, dashes, etc.) —
        # anything that isn't a letter or number has no business starting a spoken sentence
        clean = re.sub(r'^[^a-zA-Z0-9]+', '', normalized.strip())
        if not clean:
            return web.json_response({"error": "Text normalized to empty"}, status=400)

        # Replace newlines with pause markers — Kokoro ignores bare newlines but
        # respects punctuation for prosodic breaks between sections
        clean = re.sub(r'\s*\n+\s*', '... ', clean)
        # Collapse multiple consecutive dots into a single ellipsis
        clean = re.sub(r'\.{4,}', '...', clean)

        wav_bytes = synthesize(clean, req_speed)
        elapsed = time.monotonic() - start

        duration_s = len(wav_bytes) / (output_rate * 2)  # 16-bit mono
        log.info(f"Synthesized in {elapsed:.3f}s ({duration_s:.1f}s audio, {len(wav_bytes)/1024:.0f}KB)")

        return web.Response(
            body=wav_bytes,
            content_type="audio/wav",
            headers={
                "X-Synthesis-Duration": f"{elapsed:.3f}",
                "X-Audio-Duration": f"{duration_s:.1f}",
            },
        )

    except Exception as e:
        log.error(f"Synthesis error: {e}", exc_info=True)
        return web.json_response({"error": str(e)}, status=500)


async def handle_health(request: web.Request) -> web.Response:
    """GET /health"""
    return web.json_response({
        "status": "ok",
        "engine": "kokoro",
        "pipeline_loaded": pipeline is not None,
    })


def main():
    parser = argparse.ArgumentParser(description="VOQR TTS Server")
    parser.add_argument("--port", type=int, default=8100, help="Port to listen on")
    parser.add_argument("--voice-a", type=str, default="bm_fable", help="Primary voice")
    parser.add_argument("--voice-b", type=str, default="bm_george", help="Secondary voice for blending")
    parser.add_argument("--blend", type=float, default=0.5, help="Voice blend ratio (0.0 = all voice-a, 1.0 = all voice-b)")
    parser.add_argument("--speed", type=float, default=1.0, help="Speech speed multiplier")
    args = parser.parse_args()

    load_engine(args.voice_a, args.voice_b, args.blend, args.speed)

    app = web.Application()
    app.router.add_post("/synthesize", handle_synthesize)
    app.router.add_get("/health", handle_health)

    log.info(f"VOQR TTS Server starting on http://127.0.0.1:{args.port}")
    web.run_app(app, host="127.0.0.1", port=args.port, print=None)


if __name__ == "__main__":
    main()
