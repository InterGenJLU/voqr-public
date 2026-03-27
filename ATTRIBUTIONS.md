# VOQR — Open Source Attributions

VOQR is built on the shoulders of these open-source projects. Their licenses are respected in full.

## Speech-to-Text

### OpenAI Whisper
- **License:** MIT
- **Repository:** https://github.com/openai/whisper
- **Usage:** Speech-to-text model weights (ggml-tiny, ggml-base, etc.)

### whisper.cpp
- **License:** MIT
- **Repository:** https://github.com/ggerganov/whisper.cpp
- **Usage:** C++ inference engine for Whisper models. Runs as a local HTTP server for STT.

## Text-to-Speech

### Kokoro TTS
- **License:** Apache 2.0
- **Repository:** https://github.com/hexgrad/kokoro
- **Usage:** Local text-to-speech synthesis via Python server

## Voice Activity Detection

### Silero VAD
- **License:** MIT
- **Repository:** https://github.com/snakers4/silero-vad
- **Usage:** Voice activity detection model for speech segment identification

### avr-vad
- **License:** MIT
- **Repository:** https://github.com/nickarora/avr-vad
- **Usage:** Node.js wrapper for Silero VAD used in the extension host

## Audio Capture

### @analyticsinmotion/micstream
- **License:** MIT
- **Repository:** https://github.com/nickarora/micstream
- **Usage:** PortAudio-based microphone capture on Windows and macOS

### node-record-lpcm16
- **License:** MIT
- **Repository:** https://github.com/gillesdemey/node-record-lpcm16
- **Usage:** arecord wrapper for microphone capture on Linux

## Python Dependencies (TTS Server)

### aiohttp
- **License:** Apache 2.0
- **Repository:** https://github.com/aio-libs/aiohttp
- **Usage:** HTTP server framework for the Kokoro TTS server

### NumPy
- **License:** BSD 3-Clause
- **Repository:** https://github.com/numpy/numpy
- **Usage:** Audio array processing (pause compression, silence trimming, resampling)

## Additional

### VS Code Extension API
- **License:** MIT
- **Documentation:** https://code.visualstudio.com/api

All bundled model weights retain their original licenses. Users who download additional models are subject to those models' respective licenses.
