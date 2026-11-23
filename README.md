# VOQR — Voice for AI Chat

**Talk to the AI models in VS Code. Hear every answer. Local. Private. Yours.**

> *(rhymes with "poker")*

![VOQR Demo](demo.gif)

*Click to talk. AI responds by voice. Speech stays local.* [Watch with audio →](https://youtu.be/YPq_U5BSbj4)

VOQR adds voice to the AI models that VS Code offers through its [Language Model API](https://code.visualstudio.com/api/extension-guides/language-model): GitHub Copilot, Hugging Face, and any other provider that offers its models there. It cannot reach a chat that offers no models there, such as Claude Code or Codex. Speech-to-text and text-to-speech run entirely on your machine — your voice data never leaves your computer.

## Where VOQR works

VOQR 0.2.4 is offered for these four systems, and only these. What has been run on each:

| System | Voice | Tested |
|---|---|---|
| Windows (x64) | yes | voice round trip run on 2026-11-23, on a machine prepared by hand (Windows 11) |
| Linux (x64) | yes | voice round trip run on 2026-11-23, on a machine prepared by hand ([InterGenOS](https://intergenos.org) R001.4, the Linux distribution this project's author also builds) |
| Linux (arm64) | yes | built and checked; this version's package has not yet run a voice round trip on this system |
| macOS (Apple silicon) | yes | voice round trip run on 2026-11-23, on a machine prepared by hand (an M4 MacBook Air) |

- **A voice round trip:** you speak, VOQR turns your words into text, your AI answers, and VOQR speaks the answer.
- **Prepared by hand:** the speech engines (whisper.cpp with a model, and Python with Kokoro and aiohttp) were set up on that machine before the test. A run on a machine set up from nothing has not been recorded.
- **Built and checked:** the package was built from this version's code, every file in it was traced to its source, and its start-up was run in a test harness with the system read as its own. That is not a run on the system itself.
- **Remote sessions:** VOQR works when VS Code runs on the computer that has your microphone. Remote sessions (SSH, containers, WSL, Codespaces) are not supported.

**Not supported.** VOQR has no voice on these systems, and it is not offered for them:

- **Intel Macs:** not supported yet. The module that opens the microphone and the runtime of the voice-activity model have no Intel Mac build.
- **Windows on Arm and 32-bit Arm Linux:** not being actively developed until we see demand for it. The module that opens the microphone has no Windows on Arm build, and the runtime of the voice-activity model has no 32-bit Arm build.
- **Alpine Linux:** not supported, because VS Code does not run on an Alpine desktop.

VOQR 0.2.2 was offered on Intel Macs, Windows on Arm, 32-bit Arm Linux and Alpine Linux. It installed there, but it had no voice. 0.2.3 and later are not offered on those systems.

## Features

- **Through VS Code's Language Model API** — works with Copilot, Hugging Face, and any provider that properly supports it
- **Local & private** — STT (Whisper) and TTS (Kokoro) run on your hardware. No cloud. No telemetry
- **Streaming responses** — hear AI responses sentence-by-sentence as they generate, not after a long wait
- **Push-to-talk or hands-free** — toggle between manual and voice-activated modes
- **Smart text normalization** — AI responses full of markdown, code blocks, and URLs are cleaned up for natural speech
- **Setup wizard** — guided onboarding walks you through installing and configuring your first AI provider
- **Customizable** — adjust speech speed, mute/unmute TTS, choose your AI model

## Setup

VOQR runs two local speech engines, which you set up before the first use. VOQR does not install whisper.cpp or Python for you; for Kokoro and aiohttp it offers an Install button (step 3):

1. **whisper.cpp and a Whisper model** (speech to text). Get [whisper.cpp](https://github.com/ggml-org/whisper.cpp)'s `whisper-server` program, by building it or from its Windows release, and its `tiny` model (`models/download-ggml-model.sh tiny` in whisper.cpp). VOQR looks in your home folder: for `whisper.cpp/build/bin/whisper-server` and `whisper.cpp/models/ggml-tiny.bin`, and on Windows also `whisper.cpp\bin\whisper-server.exe` and `whisper.cpp\build\bin\Release\whisper-server.exe`. Anywhere else, set `voqr.whisperCppPath` and `voqr.whisperModelPath`. `tiny`, the default, is Whisper's smallest and fastest model and its least accurate ([OpenAI's model table](https://github.com/openai/whisper#available-models-and-languages)): if it mishears you, get `base` or `small` the same way and set `voqr.sttModelSize` to that name. Larger models transcribe more slowly.
2. **Python 3.10, 3.11 or 3.12** (text to speech). Kokoro does not install on Python 3.13 or later. VOQR tries `py -3.12`, `py -3.11`, `py -3.10`, `py`, `python` and `python3` on Windows, and `python3.12`, `python3.11`, `python3.10`, `python3` and `python` on Linux and macOS. It uses the first of these that has Kokoro and aiohttp installed, or else the first it finds.
3. **Kokoro and aiohttp**, installed into that Python: for example `py -3.12 -m pip install kokoro aiohttp` on Windows, or `python3.12 -m pip install kokoro aiohttp` on Linux and macOS. Kokoro brings PyTorch, which is a large download. Some Linux distributions refuse pip installs into their own Python; pip's message there names the ways around it. If Kokoro or aiohttp is missing when VOQR starts, VOQR's message names the install command for the Python it found and offers an **Install** button: it runs that command in a terminal named "VOQR: install", where pip's own output shows, and starts the speech server again when pip succeeds. If pip fails, VOQR says so, and pip's output stays in that terminal.
4. **On Linux,** `arecord`, from alsa-utils, opens the microphone. **On Windows,** voice input needs the Microsoft Visual C++ Redistributable (x64), [from Microsoft](https://learn.microsoft.com/cpp/windows/latest-supported-vc-redist); if it is missing, VOQR says so when it starts and links to that page.

Then click the mic button in the status bar (or use your platform's keybinding — see [Keybindings](#keybindings)), pick an AI provider (the setup wizard guides you if you have none), and talk. VOQR transcribes your speech, sends it to your AI, and reads the response aloud. VOQR itself needs no API key and no account.

The first time VOQR asks a provider's models for an answer, VS Code asks whether VOQR may access the language models that provider offers. That first answer waits for your choice, so it comes more slowly than the ones after it.

On first use, Kokoro downloads its model (about 330 MB) and two voices from Hugging Face, and its English text processing downloads spaCy's small English model. After that, the speech engines load them from your disk and make no network request when they start. That first start takes longer while the download runs: VOQR says that Kokoro is still starting, and speaks once it is ready.

These steps follow from VOQR's code and its dependencies' stated requirements. They have not yet been followed end to end on a clean machine.

## Supported Providers

VOQR works with any AI provider that properly implements the [VS Code Language Model API](https://code.visualstudio.com/api/extension-guides/language-model):

| Provider | Cost | Setup | Wizard |
|----------|------|-------|--------|
| **GitHub Copilot** | Copilot Free with a GitHub account | Part of recent VS Code (an extension on older versions) + GitHub sign-in | Guided |
| **Hugging Face** | Paid: credits, bought or included monthly with PRO; a free account includes none ([pricing](https://huggingface.co/docs/inference-providers/pricing)) | Install extension + access token | Guided |
| **Cerebras** | See [Cerebras pricing](https://www.cerebras.ai/pricing) | Install extension + API key | Manual — Cerebras extension does not activate reliably |
| **OpenAI Compatible** | Varies | Install extension + endpoint config | Manual — OAICopilot extension has unresolved configuration issues |

The built-in setup wizard walks you through each guided provider step by step. It does not set up the manual providers: once a provider's own extension offers its models through the Language Model API, VOQR lists them with the others.

AI Toolkit is no longer in the guided setup (0.2.4): in a test on 2026-11-23, version 1.6.21 offered no models to VOQR after its setup.

## Requirements

| Component | Details |
|-----------|---------|
| **VS Code** | 1.99.0 or later |
| **OS** | Windows (x64), Linux (x64, arm64), macOS (Apple silicon) |
| **Voice input** | Windows (x64), Linux (x64, arm64), macOS (Apple silicon). No other system is offered: see [Where VOQR works](#where-voqr-works) |
| **STT** | whisper.cpp's `whisper-server` and a Whisper model, found in your home folder or set in settings (see [Setup](#setup)) |
| **TTS** | Python 3.10, 3.11 or 3.12 with Kokoro and aiohttp, installed by you or with VOQR's Install button (see [Setup](#setup)) |
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
| `voqr.sttBackend` | `auto` | `auto` (whisper.cpp, which you install: see [Setup](#setup)), `faster-whisper` (a Python server that VOQR runs on the CPU; you install faster-whisper), or `external` (your own server at `voqr.sttServerUrl`) |
| `voqr.sttModelSize` | `tiny` | Whisper model: `tiny`, `base`, `small`, `medium`. Larger models are more accurate and slower; VOQR looks for `ggml-<size>.bin` (see [Setup](#setup)) |
| `voqr.debug` | `false` | Verbose logging to output channel |

Quick controls for speed and mute are also available directly in the VOQR panel.

## Privacy

VOQR processes all voice data locally:

- **Speech-to-text:** whisper.cpp runs on your computer — audio never leaves your machine
- **Text-to-speech:** Kokoro TTS runs on your CPU — no cloud synthesis
- **No telemetry:** VOQR collects zero usage data
- **No account for VOQR:** VOQR itself needs no sign-up; the AI provider you choose has its own account (for Copilot, a GitHub account)
- **Your AI provider:** the words VOQR transcribes go to the AI chat provider you chose, as typed words would; that provider's own terms apply to them
- **First use:** Kokoro downloads its model and voices from Hugging Face, and spaCy's English model is downloaded once; no audio is sent. Later starts load them from your disk with no network request

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
| Any AI provider | No: the models of VS Code's Language Model API (not Claude Code or Codex) | Yes | Any text field | Any text field |
| VS Code native | Yes | Yes | No (system-level) | No (system-level) |
| Custom voice | Planned | No | No | No |
| Speaker ID | Planned | No | No | No |
| Offline capable | Speech only, after the first download | Yes | No | Yes (STT only) |
| Price | Free | Free | Free / $15/mo | $8.49/mo |

The other products' columns were written in March 2026 and have not been checked again since.

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
