#!/usr/bin/env python3
"""
VOQR TTS Audio Diagnostics — programmatic analysis of Kokoro synthesis output.

Synthesizes test sentences via the TTS server, saves WAVs, and analyzes each
for known audio quality issues: wisps, boundary transients, excessive silence,
non-zero start/end samples, and interior pause lengths.

Usage:
    python3 server/tts_diagnostics.py [--server http://127.0.0.1:8100] [--output-dir debug_data/tts_diag]
"""

import argparse
import io
import json
import os
import re
import sys
import wave
from pathlib import Path

import numpy as np
import requests

# Add server dir so we can import the normalizer
sys.path.insert(0, str(Path(__file__).parent))
from tts_normalizer import TTSNormalizer

normalizer = TTSNormalizer()

SAMPLE_RATE = 48000  # TTS server outputs 48kHz after upsample


# ---------------------------------------------------------------------------
# Test sentence corpus
# ---------------------------------------------------------------------------

# Targeted: known problem patterns
TARGETED_SENTENCES = {
    "short_greeting_1": "Good evening!",
    "short_greeting_2": "Hello there.",
    "short_greeting_3": "Hi.",
    "short_exclamation": "Wow!",
    "aspirated_h_start": "How are you doing tonight?",
    "aspirated_h_mid": "I think he has the answer.",
    "aspirated_wh": "What would you like to know?",
    "aspirated_ch": "Check the configuration file.",
    "short_response": "Yes, that's correct.",
    "very_short": "OK.",
    "comma_pause": "Well, that depends on the context.",
    "colon_label": "Event Horizon: This is the point of no return.",
    "em_dash": "Nothing — not even light — can escape.",
    "semicolon": "The gravity is strong; nothing escapes.",
    "question": "Is there anything you'd like to chat about?",
    "long_sentence": "A black hole is a region in spacetime where gravity is so incredibly strong that nothing, not even electromagnetic radiation such as light, can escape from the boundary known as the event horizon once it has passed through.",
    "numbers_and_units": "The star is about 10 billion years old and weighs approximately 2.5 solar masses.",
    "url_pattern": "You can find more information at the NASA website.",
    "list_intro": "Here's an explanation, broken down into parts, trying to keep it understandable.",
    "parenthetical": "Most black holes form when very massive stars, much bigger than our sun, die.",
    "emoji_adjacent": "I'm doing well, thank you for asking!",
    "ending_period": "They're formed from the collapse of massive stars.",
    "ending_question": "Would you like me to go into more detail?",
    "ending_exclamation": "This is a relatively recent and exciting development!",
}


def extract_ai_sentences_from_debug(debug_dir: str) -> dict[str, str]:
    """Extract individual sentences from debug chat files for broad testing."""
    sentences = {}
    chat_files = sorted(Path(debug_dir).glob("*_chat.txt"))

    for chat_file in chat_files:
        text = chat_file.read_text()
        # Extract AI responses (lines after "model_name:" until next "You:")
        ai_blocks = re.findall(
            r'(?:gemma-3-27b|DeepSeek-V3\.2|deepseek-ai):\n(.*?)(?=\nYou:|\Z)',
            text, re.DOTALL
        )
        for block in ai_blocks:
            # Normalize the block
            normalized = normalizer.normalize(block)
            # Split into sentences (same logic as SpeechChunker: split on [.!?] + space/newline)
            raw_sentences = re.split(r'(?<=[.!?])\s+', normalized.strip())
            for i, sent in enumerate(raw_sentences):
                sent = sent.strip()
                if len(sent) < 3:
                    continue
                key = f"debug_{chat_file.stem}_s{i:03d}"
                sentences[key] = sent

    return sentences


# ---------------------------------------------------------------------------
# Synthesis
# ---------------------------------------------------------------------------

def synthesize(server_url: str, text: str) -> bytes | None:
    """Send text to TTS server, return WAV bytes."""
    try:
        resp = requests.post(
            f"{server_url}/synthesize",
            json={"text": text},
            timeout=30,
        )
        if resp.status_code == 200 and len(resp.content) > 100:
            return resp.content
        return None
    except Exception as e:
        print(f"  ERROR: {e}")
        return None


def wav_to_float(wav_bytes: bytes) -> np.ndarray:
    """Convert WAV bytes to float32 numpy array."""
    buf = io.BytesIO(wav_bytes)
    with wave.open(buf, "rb") as wf:
        frames = wf.readframes(wf.getnframes())
        int16 = np.frombuffer(frames, dtype=np.int16)
        return int16.astype(np.float32) / 32768.0


# ---------------------------------------------------------------------------
# Analysis
# ---------------------------------------------------------------------------

def analyze_wav(audio: np.ndarray, sr: int = SAMPLE_RATE) -> dict:
    """Run all diagnostics on an audio array. Returns a dict of metrics."""
    results = {}

    n_samples = len(audio)
    duration_ms = (n_samples / sr) * 1000
    results["duration_ms"] = round(duration_ms, 1)
    results["n_samples"] = n_samples

    if n_samples < 100:
        results["error"] = "audio too short"
        return results

    # --- Boundary analysis ---
    # First/last 5ms RMS (wisp detection)
    boundary_samples = int(sr * 0.005)  # 5ms
    body_start = int(sr * 0.05)  # skip first 50ms
    body_end = max(body_start + 1, n_samples - int(sr * 0.05))

    first_5ms_rms = np.sqrt(np.mean(audio[:boundary_samples] ** 2))
    last_5ms_rms = np.sqrt(np.mean(audio[-boundary_samples:] ** 2))
    body_rms = np.sqrt(np.mean(audio[body_start:body_end] ** 2))

    results["first_5ms_rms"] = round(float(first_5ms_rms), 6)
    results["last_5ms_rms"] = round(float(last_5ms_rms), 6)
    results["body_rms"] = round(float(body_rms), 6)

    # Wisp ratio: boundary energy relative to body
    if body_rms > 0.001:
        results["onset_ratio"] = round(first_5ms_rms / body_rms, 4)
        results["offset_ratio"] = round(last_5ms_rms / body_rms, 4)
    else:
        results["onset_ratio"] = 0.0
        results["offset_ratio"] = 0.0

    # First/last sample values (should be near zero after fade)
    results["first_sample"] = round(float(audio[0]), 6)
    results["last_sample"] = round(float(audio[-1]), 6)

    # Peak amplitude at boundaries vs body
    first_10ms = int(sr * 0.01)
    last_10ms = int(sr * 0.01)
    results["peak_first_10ms"] = round(float(np.max(np.abs(audio[:first_10ms]))), 6)
    results["peak_last_10ms"] = round(float(np.max(np.abs(audio[-last_10ms:]))), 6)
    results["peak_body"] = round(float(np.max(np.abs(audio[body_start:body_end]))), 6)

    # --- Silence analysis ---
    # Leading silence (samples before first sound above threshold)
    threshold = 0.01
    above = np.where(np.abs(audio) > threshold)[0]
    if len(above) > 0:
        leading_silence_ms = (above[0] / sr) * 1000
        trailing_silence_ms = ((n_samples - above[-1]) / sr) * 1000
    else:
        leading_silence_ms = duration_ms
        trailing_silence_ms = duration_ms

    results["leading_silence_ms"] = round(leading_silence_ms, 1)
    results["trailing_silence_ms"] = round(trailing_silence_ms, 1)

    # --- Interior pause analysis ---
    # Find longest interior silence run (10ms windows)
    window = int(sr * 0.01)  # 10ms
    n_windows = n_samples // window
    if n_windows > 2 and len(above) > 0:
        rms_windows = np.array([
            np.sqrt(np.mean(audio[i * window:(i + 1) * window] ** 2))
            for i in range(n_windows)
        ])
        voiced = np.where(rms_windows >= 0.015)[0]
        if len(voiced) >= 2:
            first_v = voiced[0]
            last_v = voiced[-1]
            max_silence_run = 0
            current_run = 0
            for i in range(first_v, last_v + 1):
                if rms_windows[i] < 0.015:
                    current_run += 1
                    max_silence_run = max(max_silence_run, current_run)
                else:
                    current_run = 0
            results["max_interior_silence_ms"] = round(max_silence_run * 10, 1)
        else:
            results["max_interior_silence_ms"] = 0.0
    else:
        results["max_interior_silence_ms"] = 0.0

    # --- Flag issues ---
    issues = []
    if results["onset_ratio"] > 0.3:
        issues.append(f"onset_wisp (ratio={results['onset_ratio']:.3f})")
    if results["offset_ratio"] > 0.3:
        issues.append(f"offset_wisp (ratio={results['offset_ratio']:.3f})")
    if abs(results["first_sample"]) > 0.01:
        issues.append(f"nonzero_start ({results['first_sample']:.4f})")
    if abs(results["last_sample"]) > 0.01:
        issues.append(f"nonzero_end ({results['last_sample']:.4f})")
    if results["leading_silence_ms"] > 200:
        issues.append(f"long_lead_silence ({results['leading_silence_ms']:.0f}ms)")
    if results["trailing_silence_ms"] > 200:
        issues.append(f"long_trail_silence ({results['trailing_silence_ms']:.0f}ms)")
    if results["max_interior_silence_ms"] > 60:
        issues.append(f"long_interior_pause ({results['max_interior_silence_ms']:.0f}ms)")
    if duration_ms < 300:
        issues.append(f"very_short_audio ({duration_ms:.0f}ms)")

    results["issues"] = issues
    return results


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(description="VOQR TTS Audio Diagnostics")
    parser.add_argument("--server", default="http://127.0.0.1:8100", help="TTS server URL")
    parser.add_argument("--output-dir", default="debug_data/tts_diag", help="Output directory for WAVs and report")
    parser.add_argument("--targeted-only", action="store_true", help="Only run targeted tests, skip debug file sweep")
    args = parser.parse_args()

    out_dir = Path(args.output_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    wav_dir = out_dir / "wavs"
    wav_dir.mkdir(exist_ok=True)

    # Build test corpus
    corpus = dict(TARGETED_SENTENCES)
    if not args.targeted_only:
        debug_dir = Path(__file__).parent.parent / "debug_data"
        if debug_dir.exists():
            debug_sentences = extract_ai_sentences_from_debug(str(debug_dir))
            corpus.update(debug_sentences)
            print(f"Corpus: {len(TARGETED_SENTENCES)} targeted + {len(debug_sentences)} from debug data = {len(corpus)} total")
        else:
            print(f"Corpus: {len(TARGETED_SENTENCES)} targeted (no debug_data dir found)")
    else:
        print(f"Corpus: {len(TARGETED_SENTENCES)} targeted only")

    # Check server
    try:
        health = requests.get(f"{args.server}/health", timeout=5)
        if health.status_code != 200:
            print(f"ERROR: TTS server not healthy at {args.server}")
            sys.exit(1)
    except Exception:
        print(f"ERROR: Cannot reach TTS server at {args.server}")
        sys.exit(1)

    print(f"TTS server: {args.server}")
    print(f"Output: {out_dir}")
    print()

    # Synthesize and analyze
    all_results = {}
    issue_count = 0

    for key, text in corpus.items():
        display = text[:70] + "..." if len(text) > 70 else text
        print(f"  [{key}] \"{display}\"")

        wav_bytes = synthesize(args.server, text)
        if wav_bytes is None:
            print(f"    SKIP: synthesis failed or empty")
            all_results[key] = {"text": text, "error": "synthesis_failed"}
            continue

        # Save WAV
        wav_path = wav_dir / f"{key}.wav"
        wav_path.write_bytes(wav_bytes)

        # Analyze
        audio = wav_to_float(wav_bytes)
        metrics = analyze_wav(audio)
        metrics["text"] = text
        metrics["text_len"] = len(text)
        metrics["wav_size_kb"] = round(len(wav_bytes) / 1024, 1)
        all_results[key] = metrics

        if metrics.get("issues"):
            issue_count += len(metrics["issues"])
            for issue in metrics["issues"]:
                print(f"    ⚠ {issue}")
        else:
            print(f"    ✓ clean ({metrics['duration_ms']:.0f}ms)")

    # Write report
    # Convert numpy types for JSON serialization
    def sanitize(obj):
        if isinstance(obj, (np.floating, np.float32, np.float64)):
            return float(obj)
        if isinstance(obj, (np.integer, np.int32, np.int64)):
            return int(obj)
        return obj

    report_path = out_dir / "report.json"
    with open(report_path, "w") as f:
        json.dump(all_results, f, indent=2, default=sanitize)

    # Summary
    print()
    print("=" * 60)
    print(f"SUMMARY: {len(all_results)} sentences analyzed")

    clean = sum(1 for r in all_results.values() if not r.get("issues") and not r.get("error"))
    errored = sum(1 for r in all_results.values() if r.get("error"))
    flagged = sum(1 for r in all_results.values() if r.get("issues"))

    print(f"  Clean: {clean}")
    print(f"  Flagged: {flagged} ({issue_count} total issues)")
    print(f"  Errors: {errored}")
    print()

    if flagged:
        print("FLAGGED SENTENCES:")
        for key, r in all_results.items():
            if r.get("issues"):
                print(f"  [{key}] {r.get('text', '')[:60]}")
                for issue in r["issues"]:
                    print(f"    - {issue}")
        print()

    # Print readable summary table for quick scanning
    print("BOUNDARY ANALYSIS (onset/offset ratios — lower is better, >0.3 flagged):")
    print(f"  {'Key':<40} {'Onset':>7} {'Offset':>7} {'Lead ms':>8} {'Trail ms':>9} {'Int ms':>7}")
    print(f"  {'-'*40} {'-'*7} {'-'*7} {'-'*8} {'-'*9} {'-'*7}")
    for key, r in sorted(all_results.items()):
        if r.get("error"):
            continue
        onset = r.get("onset_ratio", 0)
        offset = r.get("offset_ratio", 0)
        lead = r.get("leading_silence_ms", 0)
        trail = r.get("trailing_silence_ms", 0)
        interior = r.get("max_interior_silence_ms", 0)
        flag = " ⚠" if r.get("issues") else ""
        print(f"  {key:<40} {onset:>7.3f} {offset:>7.3f} {lead:>7.1f} {trail:>8.1f} {interior:>7.1f}{flag}")

    print()
    print(f"Full report: {report_path}")
    print(f"WAV files: {wav_dir}/")


if __name__ == "__main__":
    main()
