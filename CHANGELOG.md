# Changelog

All notable changes to VOQR will be documented in this file.

Format follows [Keep a Changelog](https://keepachangelog.com/). Versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.2.4] - 2026-11-23

### Added
- When Kokoro or aiohttp is missing from the Python VOQR found (Python 3.10 to 3.12), its message offers an Install button. It runs that Python's `pip install` for the missing packages in a terminal named "VOQR: install", where pip's own output shows, and starts the speech server again when pip succeeds
- VOQR names the microphone input in its log and in the panel, on every system. When the open microphone has heard nothing for 5 seconds, the panel says "No sound from" that input and asks you to check the input device

### Fixed
- Kokoro's first start downloads its model (about 330 MB). VOQR gave up on it after 30 seconds and stayed silent until VS Code was reloaded. It now waits while the server runs, says once that it is still starting or downloading, and turns voice output on in the same session. Speech recognition, which was given 15 seconds, waits the same way. After 15 minutes without an answer, VOQR says so and keeps waiting
- A speech server that ends by itself is started again up to three times and then named in a message. Before, an end by a signal or with exit code 0 was told to nobody. A text-to-speech failure that lasts, such as a missing package or an unsuitable Python, is told at once, without retries
- The model list keeps each model by its own id. Models with the same name were merged, so picking "GPT-5.6 Luna" in VS Code 1.147's built-in Copilot sent every request to a model kept for VS Code itself, which refuses extensions. A model refused that way now leaves the list with a plain message, and a change in the list keeps the model you picked while it is still offered
- Kokoro makes no network request at start once its files are on your disk; it asked Hugging Face about them at every start. The faster-whisper backend tries your disk before the network
- The guided setup no longer offers AI Toolkit, whose version 1.6.21 offered VOQR no models in a test, and no longer installs GitHub Copilot when VS Code has it built in
- The description and the README say which chats VOQR reaches: the models that VS Code offers through its Language Model API, such as GitHub Copilot's and Hugging Face's. Claude Code and Codex offer none there, so VOQR cannot reach them. Before, they said that VOQR worked with every chat in VS Code
- The README and the speech-recognition setting no longer claim what VOQR does not do. A custom voice and speaker identification are planned, not offered. VOQR runs faster-whisper on the CPU, not on a GPU, and it is not a paid feature. whisper.cpp is not bundled: you install it (see Setup). The README also says that VOQR works offline for speech only, after the first download, and it dates the other products' columns of its comparison

### Changed
- The README's systems table lists only the four systems VOQR is offered on; the others are named below it, each with its reason
- The README lists Hugging Face as paid: since 2026-10-07 its free accounts get no inference credits. It notes that the first answer of a new install waits for VS Code's one-time prompt to let VOQR use the model, and that Whisper's tiny model is its least accurate

## [0.2.3] - 2026-11-22

This version corrects 0.2.2, which was offered on systems where VOQR has no voice.

### Removed
- The packages for Intel Macs, Windows on Arm, 32-bit Arm Linux and Alpine Linux. 0.2.2 added them so that those systems would no longer get 0.2.0, which cannot start. On them VOQR installed and started, but it had no voice, while the Marketplace's Install button and the "Added" entry below read as support. VOQR 0.2.3 is offered for Windows (x64), Linux (x64, arm64) and macOS (Apple silicon) only

### Added
- The README opens with a table of the systems VOQR is offered on, and of what has been run on each
- In a remote session (SSH, containers, WSL, Codespaces), VOQR says once that it works only when VS Code runs on the computer that has your microphone

### Fixed
- When the text-to-speech server cannot start, VOQR shows the server's own reason, for example that Kokoro is not installed, with the install command for the Python it found. 0.2.2 showed "crashed and could not restart ... Try reloading VS Code" and, 30 seconds later, four warnings that the server failed to start, none of which said why; it also restarted three times a server that could only fail the same way
- On a Python where Kokoro cannot install (3.13 and later), the text-to-speech server says that Kokoro needs Python 3.10 to 3.12
- VOQR uses the first Python it finds that has Kokoro and aiohttp installed, so a setup that works keeps its Python when another is added. When none has them, it looks for Python 3.12, 3.11 and 3.10 before the plain `python3` on Linux and macOS, and no longer tries Python 3.13 before 3.10 on Windows
- The README's setup steps say what you install yourself: whisper.cpp and a Whisper model, and Python 3.10 to 3.12 with Kokoro and aiohttp. It said before that no configuration was required and that Kokoro was installed on first use, which it is not

## [0.2.2] - 2026-11-22

### Added
- Packages for Intel Macs (darwin-x64), Windows on Arm (win32-arm64), 32-bit Arm Linux (linux-armhf) and Alpine Linux (alpine-x64, alpine-arm64), so those systems no longer get 0.2.0, which cannot start. They have no voice input: micstream 0.4.0, which opens the microphone on Windows and macOS, has no build for Windows on Arm or Intel Macs, and ONNX Runtime 1.24.3, which runs the voice-activity model, has none for Intel Macs or 32-bit Arm, and its Linux builds need glibc, which Alpine Linux does not use. VOQR starts there, starts no speech server, and says why when the mic button is pressed

### Fixed
- Linux: push to talk no longer fails with "No such recorder found: arecord". 0.2.1 bundled node-record-lpcm16 into the extension, and that module looks for its recorder file beside itself, which the bundle moved away from. It now ships under node_modules in the Linux x64 and arm64 packages, together with debug and ms, and loads when the microphone opens
- The panel and the status bar show only the capture state VOQR is in. Since 0.2.0 they could say VOQR was listening when it was not: after a microphone that could not start (no Visual C++ runtime, no arecord, a device error), after a microphone error or a microphone stream that ended by itself, and in push to talk after VOQR spoke its answer; when the answer ended, the status bar could also say idle while a microphone started during the answer was listening. The "say hi" prompt now appears once the microphone is open, not when the button is pressed, and goes when the microphone stops
- A microphone error on Linux names the recorder's exit (for example "arecord has exited with error code 1") instead of "unknown"
- The panel writes the chat model's name and the setup wizard's error messages as text, so markup in them is shown as written instead of becoming part of the page

### Changed
- Linux: the packages no longer carry micstream, and VOQR no longer loads it at start-up there. arecord opens the microphone on Linux; micstream, which VOQR's own notes say crashes on Linux, was loaded only to log its devices

### Security
- VOQR looks for its Python server scripts in its own folder only. 0.2.1 would also have run a script named like them from the working directory, or from the folder that holds every extension, if its own copy were missing, which no package lacks

## [0.2.1] - 2026-11-21

### Fixed
- VOQR activates after install again. 0.2.0 was packaged without the modules it loads at start-up and failed with "Cannot find module 'avr-vad'" ([#1](https://github.com/InterGenJLU/voqr-public/issues/1)). avr-vad, onnxruntime-node and micstream now ship inside the package, and node-record-lpcm16 is bundled into the extension
- A native module that cannot load no longer stops VOQR from activating: the voice-activity model is loaded when voice input starts

### Added
- Windows: if the Microsoft Visual C++ Redistributable (x64) is missing, VOQR names the missing files at start-up and links to Microsoft's download page. Voice input needs it
- License texts for the third-party code the package carries, in the package's `licenses` folder

### Changed
- Packages are built per platform and carry only that platform's native files. ONNX Runtime 1.24.3 has no Intel Mac build and micstream has no Windows on Arm build, so there is no package for those two platforms
- Packages no longer carry source maps or files left over from earlier builds

## [0.2.0] - 2026-03-30

### Added
- TTS pronunciation dictionary with 150+ acronyms across 8 domains (developer tools, networking, cloud, cybersecurity, healthcare, hardware, data formats, general)
- Word-slash normalization: "consent/authorization" is now read as "consent or authorization"
- AI Toolkit wizard redesigned with honest disclosure of what gets installed (130+ models)
- Wizard resume after window reload — wizard returns to the correct step instead of leaving the user stranded
- New wizard step types: choice cards and model selection checkboxes
- Cerebras endpoint documented as alternative via OpenAI Compatible provider

### Changed
- Wizard UI scaled for 4K displays (absolute px sizing)
- Wizard step icons colored in Signal Teal
- AI Toolkit moved from "paid" to "free" tier in provider list

### Fixed
- Show-more dropdown: expanding a vendor's model list no longer jumps models to the top of the dropdown — models expand in-place under their correct header

### Disabled
- Cerebras wizard — extension does not activate reliably on Linux. Will be re-enabled when the provider fixes the issue
- OpenAI Compatible wizard — OAICopilot extension has unresolved configuration issues. Will be re-enabled when the provider fixes the issue

## [0.1.0] - 2026-03-27

### Added
- Voice interaction for every AI chat provider in VS Code
- Local speech-to-text via whisper.cpp (CPU)
- Local text-to-speech via Kokoro TTS
- Streaming sentence-level TTS — hear responses as they generate
- Push-to-talk and hands-free (VAD) modes
- Setup wizards for GitHub Copilot, HuggingFace, and AI Toolkit
- Smart text normalization (169 tests) — markdown, code blocks, URLs, operators, units, currency, and more cleaned up for natural speech
- Model selector with vendor grouping, colored headers, and search
- Guided onboarding for first-time users
- Cross-platform support: Linux, Windows, macOS
- TTS speed control, mute toggle, and settings UI
- Zero telemetry — no data collection of any kind
