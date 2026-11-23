# VOQR — Voice for AI Chat

**Talk to any AI. Hear every answer. Local. Private. Yours.**

> *(rhymes with "poker")*

![VOQR Demo](demo.gif)

*Click to talk. AI responds by voice. All local.* [Watch with audio →](https://youtu.be/YPq_U5BSbj4)

VOQR adds voice interaction to every AI chat provider in VS Code. Speech-to-text and text-to-speech run entirely on your machine — your voice data never leaves your computer.

## Where VOQR works

VOQR 0.2.3 is offered for four systems. What has been run on each:

| System | Voice | Tested |
|---|---|---|
| Windows (x64) | yes | built and checked; this version's package has not yet run a voice round trip on this system; voice ran on a development build in March 2026 |
| Linux (x64) | yes | built and checked; this version's package has not yet run a voice round trip on this system; voice ran on a development build in March 2026, on Ubuntu 24.04 |
| Linux (arm64) | yes | built and checked; this version's package has not yet run a voice round trip on this system |
| macOS (Apple silicon) | yes | built and checked; this version's package has not yet run a voice round trip on this system; voice ran on a development build in March 2026, on an M4 MacBook Air |
| macOS (Intel) | no | not supported yet |
| Windows on Arm | no | not supported: not being actively developed until we see demand for it |
| Linux (32-bit Arm) | no | not supported: not being actively developed until we see demand for it |
| Alpine Linux | no | not supported: VS Code does not run on an Alpine desktop |

- **A voice round trip:** you speak, VOQR turns your words into text, your AI answers, and VOQR speaks the answer.
- **Built and checked:** the package was built from this version's code, every file in it was traced to its source, and its start-up was run in a test harness with the system read as its own. That is not a run on the system itself.
- **Remote sessions:** VOQR works when VS Code runs on the computer that has your microphone. Remote sessions (SSH, containers, WSL, Codespaces) are not supported.
- **Intel Macs:** not supported yet. The module that opens the microphone and the runtime of the voice-activity model have no Intel Mac build.
- **Windows on Arm and 32-bit Arm Linux:** not being actively developed until we see demand for it. The module that opens the microphone has no Windows on Arm build, and the runtime of the voice-activity model has no 32-bit Arm build.
- **Alpine Linux:** not supported, because VS Code does not run on an Alpine desktop.

VOQR 0.2.2 was offered on Intel Macs, Windows on Arm, 32-bit Arm Linux and Alpine Linux. It installed there, but it had no voice. 0.2.3 is not offered on those systems.

## Features

- **Universal** — works with Copilot, HuggingFace, AI Toolkit, and any provider that properly supports the VS Code Language Model API
- **Local & private** — STT (Whisper) and TTS (Kokoro) run on your hardware. No cloud. No telemetry
- **Streaming responses** — hear AI responses sentence-by-sentence as they generate, not after a long wait
- **Push-to-talk or hands-free** — toggle between manual and voice-activated modes
- **Smart text normalization** — AI responses full of markdown, code blocks, and URLs are cleaned up for natural speech
- **Setup wizard** — guided onboarding walks you through installing and configuring your first AI provider
- **Customizable** — adjust speech speed, mute/unmute TTS, choose your AI model

## Setup

VOQR runs two local speech engines, and it does not install them for you. Before the first use:

1. **whisper.cpp and a Whisper model** (speech to text). Get [whisper.cpp](https://github.com/ggml-org/whisper.cpp)'s `whisper-server` program, by building it or from its Windows release, and its `tiny` model (`models/download-ggml-model.sh tiny` in whisper.cpp). VOQR looks in your home folder: for `whisper.cpp/build/bin/whisper-server` and `whisper.cpp/models/ggml-tiny.bin`, and on Windows also `whisper.cpp\bin\whisper-server.exe` and `whisper.cpp\build\bin\Release\whisper-server.exe`. Anywhere else, set `voqr.whisperCppPath` and `voqr.whisperModelPath`.
2. **Python 3.10, 3.11 or 3.12** (text to speech). Kokoro does not install on Python 3.13 or later. VOQR tries `py -3.12`, `py -3.11`, `py -3.10`, `py`, `python` and `python3` on Windows, and `python3.12`, `python3.11`, `python3.10`, `python3` and `python` on Linux and macOS. It uses the first of these that has Kokoro and aiohttp installed, or else the first it finds.
3. **Kokoro and aiohttp**, installed into that Python: for example `py -3.12 -m pip install kokoro aiohttp` on Windows, or `python3.12 -m pip install kokoro aiohttp` on Linux and macOS. Kokoro brings PyTorch, which is a large download. Some Linux distributions refuse pip installs into their own Python; pip's message there names the ways around it. If something is missing when VOQR starts, VOQR shows the speech server's own message, which names the install command for the Python it found.
4. **On Linux,** `arecord`, from alsa-utils, opens the microphone. **On Windows,** voice input needs the Microsoft Visual C++ Redistributable (x64), [from Microsoft](https://learn.microsoft.com/cpp/windows/latest-supported-vc-redist); if it is missing, VOQR says so when it starts and links to that page.

Then click the mic button in the status bar (or use your platform's keybinding — see [Keybindings](#keybindings)), pick an AI provider (the setup wizard guides you if you have none), and talk. VOQR transcribes your speech, sends it to your AI, and reads the response aloud. VOQR itself needs no API key and no account.

On first use, Kokoro downloads its model (about 330 MB) and two voices from Hugging Face, and its English text processing downloads spaCy's small English model. After that, speech runs without a network connection.

These steps follow from VOQR's code and its dependencies' stated requirements. They have not yet been followed end to end on a clean machine.

## Supported Providers

VOQR works with any AI provider that properly implements the [VS Code Language Model API](https://code.visualstudio.com/api/extension-guides/language-model):

| Provider | Cost | Setup | Wizard |
|----------|------|-------|--------|
| **GitHub Copilot** | Free tier (50 msgs/mo) | Install extension + GitHub sign-in | Guided |
| **HuggingFace** | Free tier available | Install extension + API token | Guided |
| **AI Toolkit** | Free (GitHub Models + local) | Install extension | Guided |
| **Cerebras** | Free tier available | Install extension + API key | Manual — Cerebras extension does not activate reliably |
| **OpenAI Compatible** | Varies | Install extension + endpoint config | Manual — OAICopilot extension has unresolved configuration issues |

The built-in setup wizard walks you through each guided provider step by step. Manual providers work with VOQR but require independent configuration — VOQR will detect them automatically once set up.

## Requirements

| Component | Details |
|-----------|---------|
| **VS Code** | 1.99.0 or later |
| **OS** | Windows (x64), Linux (x64, arm64), macOS (Apple silicon) |
| **Voice input** | Windows (x64), Linux (x64, arm64), macOS (Apple silicon). No other system is offered: see [Where VOQR works](#where-voqr-works) |
| **STT** | whisper.cpp's `whisper-server` and a Whisper model, found in your home folder or set in settings (see [Setup](#setup)) |
| **TTS** | Python 3.10, 3.11 or 3.12 with Kokoro and aiohttp, installed by you (see [Setup](#setup)) |
| **Linux** | arecord, from alsa-utils, for voice input |
| **Windows** | Microsoft Visual C++ Redistributable (x64), for voice input — [download from Microsoft](https://learn.microsoft.com/cpp/windows/latest-supported-vc-redist) |

On Windows x64, VOQR's voice-activity model runs on ONNX Runtime, which needs the Microsoft Visual C++ Redistributable (x64). If it is missing, VOQR says so when it starts and links to Microsoft's download page.

## Keybindings

| Action | Linux | Windows | macOS |
|--------|-------|---------|-------|
| Push to Talk | `Ctrl+Shift+Space` | `Ctrl+F9` | `Cmd+Shift+Space` |
| Toggle Voice Panel | `Ctrl+Shift+V` | `Ctrl+Shift+V` | `Cmd+Shift+V` |

The **status bar mic button** is always available as an alternative — no keybinding needed.

## Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `voqr.inputMode` | `pushToTalk` | `pushToTalk` or `voiceActivity` (hands-free) |
| `voqr.ttsSpeed` | `1.0` | Speech speed (0.5× – 2.0×) |
| `voqr.ttsAutoPlay` | `true` | Automatically speak AI responses |
| `voqr.sttBackend` | `auto` | `auto` (whisper.cpp), `faster-whisper` (GPU), or `external` |
| `voqr.sttModelSize` | `tiny` | Whisper model: `tiny`, `base`, `small`, `medium` |
| `voqr.debug` | `false` | Verbose logging to output channel |

Quick controls for speed and mute are also available directly in the VOQR panel.

## Privacy

VOQR processes all voice data locally:

- **Speech-to-text:** whisper.cpp runs on your CPU — audio never leaves your machine
- **Text-to-speech:** Kokoro TTS runs on your CPU — no cloud synthesis
- **No telemetry:** VOQR collects zero usage data
- **No account required:** Free tier works without sign-up
- **Your AI provider:** the words VOQR transcribes go to the AI chat provider you chose, as typed words would; that provider's own terms apply to them
- **First use:** Kokoro downloads its model and voices from Hugging Face, and spaCy's English model is downloaded once; no audio is sent

For a voice extension, *"we collect no data"* is a feature, not a gap.

## How It Works

```
You speak → Mic capture → Voice activity detection (Silero VAD)
→ Speech-to-text (whisper.cpp) → AI model (your chosen provider)
→ Streaming response → Text normalization → Text-to-speech (Kokoro)
→ You hear the answer — sentence by sentence, as it generates
```

## Comparison

| | VOQR | VS Code Speech | Wispr Flow | Superwhisper |
|---|---|---|---|---|
| Local STT | Yes | Yes | No (cloud) | Yes |
| Local TTS | Yes | Limited | No | No |
| Any AI provider | Yes | Yes | Any text field | Any text field |
| VS Code native | Yes | Yes | No (system-level) | No (system-level) |
| Custom voice | Yes | No | No | No |
| Speaker ID | Coming Soon | No | No | No |
| Offline capable | Yes | Yes | No | Yes (STT only) |
| Price | Free | Free | Free / $15/mo | $8.49/mo |

## What's Next

- **v0.4** — Zero-config: bundled STT and TTS, no external server setup required
- **v1.0** — Pro features: speaker verification, custom voice blending, voice commands, audio + text sync with pause/resume

Follow development at [github.com/InterGenJLU/voqr-public](https://github.com/InterGenJLU/voqr-public).

## Contributing

VOQR is MIT licensed. Issues, feature requests, and voice quality reports welcome:

- [Bug Report](https://github.com/InterGenJLU/voqr-public/issues/new?template=bug_report.md)
- [Feature Request](https://github.com/InterGenJLU/voqr-public/issues/new?template=feature_request.md)
- [Voice Quality Report](https://github.com/InterGenJLU/voqr-public/issues/new?template=voice_quality.yml)

## License

MIT — see [LICENSE](LICENSE).

Open-source attributions: [ATTRIBUTIONS.md](ATTRIBUTIONS.md).

---

*VOQR is an independent project and is not affiliated with, endorsed by, or sponsored by any AI provider. All product names, trademarks, and registered trademarks are property of their respective owners.*
