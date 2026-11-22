# Changelog

All notable changes to VOQR will be documented in this file.

Format follows [Keep a Changelog](https://keepachangelog.com/). Versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

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
