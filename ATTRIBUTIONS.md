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

### faster-whisper
- **License:** MIT
- **Repository:** https://github.com/SYSTRAN/faster-whisper
- **Usage:** GPU-accelerated Whisper inference via CTranslate2 (Pro STT backend)

## Text-to-Speech

### Kokoro TTS
- **License:** Apache 2.0
- **Repository:** https://github.com/hexgrad/kokoro
- **Usage:** Local text-to-speech synthesis via Python server

## Voice Activity Detection

### Silero VAD
- **License:** MIT (Copyright (c) 2020-present Silero Team)
- **Repository:** https://github.com/snakers4/silero-vad
- **Usage:** Voice activity detection model for speech segment identification. The model files ship inside avr-vad.

### avr-vad
- **License:** MIT (Copyright (c) 2025 Agent Voice Response)
- **Repository:** https://github.com/agentvoiceresponse/avr-vad
- **Usage:** Node.js wrapper for Silero VAD used in the extension host. Shipped in the package with its license file.

### ONNX Runtime (onnxruntime-node, onnxruntime-common)
- **License:** MIT (Copyright (c) Microsoft Corporation), with third-party notices for the components built into its binaries
- **Website:** https://onnxruntime.ai
- **Usage:** Runs the Silero VAD model. Its native library ships in the package for the package's platform; the license and notices travel in the package's licenses folder.

## Audio Capture

### @analyticsinmotion/micstream
- **License:** Apache 2.0
- **Repository:** https://github.com/analyticsinmotion/micstream
- **Usage:** PortAudio-based microphone capture on Windows and macOS. Shipped in the package with its license file.

### PortAudio
- **License:** PortAudio license (Copyright (c) 1999-2006 Ross Bencina and Phil Burk)
- **Website:** http://www.portaudio.com
- **Usage:** Audio input library compiled into micstream's native module

### node-gyp-build
- **License:** MIT (Copyright (c) 2017 Mathias Buus)
- **Repository:** https://github.com/prebuild/node-gyp-build
- **Usage:** Loads micstream's prebuilt native module

### node-record-lpcm16
- **License:** ISC (Copyright 2019 Gilles De Mey)
- **Repository:** https://github.com/gillesdemey/node-record-lpcm16
- **Usage:** arecord wrapper for microphone capture on Linux. Bundled into the extension together with debug (MIT, Copyright (c) 2014 TJ Holowaychuk) and ms (MIT, Copyright (c) 2016 Zeit, Inc.).

The full license texts of the components above that the VOQR package carries are in the package's licenses folder.

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
