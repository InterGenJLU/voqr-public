# Changelog

All notable changes to VOQR will be documented in this file.

Format follows [Keep a Changelog](https://keepachangelog.com/). Versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

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
