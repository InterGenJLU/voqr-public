# VOQR — Product Vision

**Last updated:** March 23, 2026

---

## What VOQR Is

VOQR is a VS Code extension that makes every AI chat interface voice-interactive using local speech-to-text and text-to-speech. Talk to any AI. Hear every answer. Local. Private. Yours.

## What VOQR Is NOT

- **Not a new AI model.** VOQR is a voice layer that sits between the user and existing AI providers. It has no intelligence of its own.
- **Not a cloud service.** Voice processing happens on the user's machine. Period.
- **Not a Copilot replacement.** VOQR enhances AI assistants — it doesn't compete with them.
- **Not JARVIS.** JARVIS is a personal voice assistant with routing, skills, memory, and governance. VOQR is a focused product that does one thing: adds voice to AI chat in VS Code.

## Core Principles

### 1. Local-First, Always
Voice data never leaves the user's machine for processing. STT runs locally. TTS runs locally. This is not negotiable. Cloud fallback may be offered as an opt-in convenience, but the default is always local.

**Why:** Privacy is the moat. Every competitor sends voice to the cloud. We don't. In a world of GDPR, EU AI Act, and growing enterprise data sensitivity, local-first isn't a limitation — it's the selling point.

### 2. Universal, Not Proprietary
VOQR works with every AI chat provider in VS Code — Copilot, Claude, Gemini, DeepSeek, Continue.dev, and any future Language Model provider. We use the official VS Code Language Model API, not provider-specific hacks.

**Why:** Lock-in is a losing strategy when the platform owner (Microsoft) controls Copilot. Our value is in the voice layer, not the AI backend. Being universal means every new AI provider in VS Code automatically grows our addressable market.

### 3. Works Out of the Box
Install the extension, click the mic button, talk. Zero configuration required for the basic experience. Bundled STT and TTS models handle everything.

**Why:** Developer tools that require setup don't get adopted. The power user can configure a GPU-accelerated server for better quality, but the default must just work.

### 4. Customizable Voice
Users choose how their AI sounds. Voice blending, speed control, pronunciation dictionaries. The AI's voice is part of the user's workspace, not imposed by us.

**Why:** Voice is personal. A developer who spends 8 hours a day hearing AI responses should enjoy how it sounds. This is a premium differentiator that cloud TTS services can't match.

### 5. Respect the Platform
We use stable, official VS Code APIs. We don't monkey-patch other extensions, intercept private APIs, or do anything that would break across VS Code updates. When proposed APIs (like the Speech Provider API) are finalized, we adopt them.

**Why:** Longevity. Extensions that hack around the platform break constantly and get delisted. We build on solid ground.

## What We Will NOT Do

- **Never collect voice data.** No telemetry on audio content. Usage analytics (feature adoption, error rates) only, and opt-in.
- **Never require an account.** Free tier works without sign-up. Pro tier uses VS Code marketplace licensing.
- **Never lock features behind a specific AI provider.** If it works with Copilot, it works with Claude. No favorites.
- **Never bundle a large model without the user's consent.** The default bundled model is small (~75MB). Larger models are optional downloads.
- **Never break the user's workflow.** Voice is additive. Every interaction that works by voice also works by keyboard. Voice is an option, not a requirement.

## Target User

Primary: A developer who uses AI assistants in VS Code daily and wants to interact with them by voice — either for speed, accessibility, ergonomics, or preference.

Secondary: Enterprise teams that need voice interaction with AI tools but cannot send voice data to cloud services due to compliance requirements.

## Competitive Position

| | VOQR | VS Code Speech | Wispr Flow | Superwhisper |
|---|---|---|---|---|
| Local STT | Yes | Yes | No (cloud) | Yes |
| Local TTS | Yes | Limited | No | No |
| Universal AI | Yes | Copilot only | Any text field | Any text field |
| VS Code native | Yes | Yes | No (system-level) | No (system-level) |
| Custom voice | Yes | No | No | No |
| Speaker ID | Yes | No | No | No |
| Offline capable | Yes | Yes | No | Yes (STT only) |
| Price | Freemium | Free | $15/mo | $8.49/mo |

## Attribution & Licensing

### Open Source Components
- **Whisper** (OpenAI) — MIT License
- **Kokoro TTS** — Apache 2.0 License
- **SpeechBrain** — Apache 2.0 License
- **Silero VAD** — MIT License

All attributions maintained in ATTRIBUTIONS.md and in the extension's About panel. License compliance is non-negotiable — every dependency's license terms are respected and displayed.

### VOQR Licensing
- **Core extension:** MIT License (open source)
- **Pro features:** Proprietary (speaker ID, custom voices, voice commands) — sold via VS Code marketplace

## Scope Boundaries

If a proposed feature doesn't serve "adding voice to AI chat in VS Code," it doesn't belong in VOQR. Specifically:

**In scope:**
- Voice input to AI chat
- Voice output from AI responses
- Voice commands for VS Code actions (run, build, commit)
- Speaker verification
- Custom TTS voices and pronunciation
- Conversation history with playback

**Out of scope (do NOT build):**
- AI model hosting or inference
- Code generation or completion (that's the AI provider's job)
- File management, git operations, or project management
- Anything that requires an internet connection to function
- Mobile or web versions (VS Code desktop only for now)
- Integration with non-VS-Code editors

## Revenue Goal

**Year 1:** $120K ARR (conservative) to $720K ARR (optimistic)
**Break-even:** Month 4-6 (minimal costs — hosting for landing page only)
**Target:** Self-sustaining product income within the severance runway
