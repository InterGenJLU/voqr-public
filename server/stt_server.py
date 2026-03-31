#!/usr/bin/env python3
"""
VOQR STT Server — Standalone faster-whisper HTTP server.

Usage:
    python3 server/stt_server.py [--port 8099] [--model tiny] [--device cpu]

Accepts POST /transcribe with multipart audio file, returns JSON { "text": "..." }
"""

import argparse
import io
import logging
import sys
import tempfile
import time
from pathlib import Path

import numpy as np

try:
    from faster_whisper import WhisperModel
except ImportError:
    print("ERROR: faster-whisper not installed. Run: pip install faster-whisper", file=sys.stderr)
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
log = logging.getLogger("voqr-stt")

model: WhisperModel | None = None


def load_model(model_size: str, device: str, compute_type: str) -> WhisperModel:
    """Load the Whisper model."""
    log.info(f"Loading faster-whisper model: {model_size} (device={device}, compute={compute_type})")
    start = time.monotonic()
    m = WhisperModel(model_size, device=device, compute_type=compute_type)
    elapsed = time.monotonic() - start
    log.info(f"Model loaded in {elapsed:.2f}s")
    return m


def preprocess_audio(audio_data: np.ndarray, sample_rate: int = 16000) -> np.ndarray:
    """Basic audio preprocessing — normalize gain if too quiet."""
    # Ensure float32
    if audio_data.dtype != np.float32:
        audio_data = audio_data.astype(np.float32)

    # Ensure mono
    if audio_data.ndim > 1:
        audio_data = audio_data.mean(axis=1)

    # Gain normalization — boost quiet audio
    peak = np.abs(audio_data).max()
    if peak > 0 and peak < 0.7:
        gain = min(0.7 / peak, 10.0)
        audio_data = np.clip(audio_data * gain, -1.0, 1.0)

    return audio_data


async def handle_transcribe(request: web.Request) -> web.Response:
    """Handle POST /transcribe — accepts multipart audio, returns JSON."""
    global model
    if model is None:
        return web.json_response({"error": "Model not loaded"}, status=503)

    try:
        reader = await request.multipart()
        audio_field = None
        while True:
            field = await reader.next()
            if field is None:
                break
            if field.name in ("file", "audio"):
                audio_field = field
                break

        if audio_field is None:
            return web.json_response({"error": "No audio field ('file' or 'audio') in request"}, status=400)

        audio_bytes = await audio_field.read()
        log.info(f"Received {len(audio_bytes)} bytes of audio")

        # Write to temp file for faster-whisper (it reads files)
        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
            tmp.write(audio_bytes)
            tmp_path = tmp.name

        start = time.monotonic()

        segments, info = model.transcribe(
            tmp_path,
            language="en",
            beam_size=3,
            vad_filter=True,
            vad_parameters=dict(
                threshold=0.3,
                min_speech_duration_ms=100,
                min_silence_duration_ms=200,
            ),
            temperature=0.0,
            condition_on_previous_text=False,
            compression_ratio_threshold=2.4,
            log_prob_threshold=-1.0,
            no_speech_threshold=0.6,
        )

        text = " ".join(seg.text.strip() for seg in segments).strip()
        elapsed = time.monotonic() - start

        log.info(f"Transcription ({elapsed:.3f}s): \"{text}\"")

        # Clean up temp file
        Path(tmp_path).unlink(missing_ok=True)

        return web.json_response({
            "text": text,
            "language": info.language,
            "language_probability": info.language_probability,
            "duration": elapsed,
        })

    except Exception as e:
        log.error(f"Transcription error: {e}", exc_info=True)
        return web.json_response({"error": str(e)}, status=500)


async def handle_health(request: web.Request) -> web.Response:
    """GET /health — check if server is running and model is loaded."""
    return web.json_response({
        "status": "ok",
        "model_loaded": model is not None,
    })


def main():
    global model

    parser = argparse.ArgumentParser(description="VOQR STT Server")
    parser.add_argument("--port", type=int, default=8099, help="Port to listen on")
    parser.add_argument("--model", type=str, default="tiny", help="Whisper model size (tiny, base, small, medium)")
    parser.add_argument("--device", type=str, default="cpu", help="Device: cpu or cuda")
    parser.add_argument("--compute-type", type=str, default="int8", help="Compute type: int8, float16, float32")
    args = parser.parse_args()

    model = load_model(args.model, args.device, args.compute_type)

    app = web.Application()
    app.router.add_post("/transcribe", handle_transcribe)
    app.router.add_get("/health", handle_health)

    log.info(f"VOQR STT Server starting on http://127.0.0.1:{args.port}")
    log.info(f"Model: {args.model} | Device: {args.device} | Compute: {args.compute_type}")
    web.run_app(app, host="127.0.0.1", port=args.port, print=None)


if __name__ == "__main__":
    main()
