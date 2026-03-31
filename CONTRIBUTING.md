# Contributing to VOQR

Thank you for your interest in VOQR! We welcome bug reports, feature requests, voice quality reports, and code contributions.

## Reporting Issues

- [Bug Report](https://github.com/InterGenJLU/voqr-public/issues/new?template=bug_report.md)
- [Feature Request](https://github.com/InterGenJLU/voqr-public/issues/new?template=feature_request.md)
- [Voice Quality Report](https://github.com/InterGenJLU/voqr-public/issues/new?template=voice_quality.md)

Voice quality reports are especially valuable — if the AI's response sounds wrong, unnatural, or mispronounces a term, let us know. These directly improve the TTS normalizer for everyone.

## Development Setup

1. Clone the repository
2. Run `npm install`
3. Run `npm run build` to compile
4. Press `F5` in VS Code to launch the Extension Development Host
5. Run `npm test` to run the test suite (210 tests)
6. Run `npm run lint` to check for lint errors

### Requirements

- Node.js 18+
- Python 3.10–3.13 (for TTS server)
- whisper.cpp (for STT)

## Code Guidelines

- **TypeScript strict mode** — no `any` types
- **ESLint clean** — run `npm run lint` before submitting
- **Tests** — add tests for new normalizer rules (`npm test`)
- **No telemetry** — VOQR collects zero data. Do not add analytics, tracking, or usage reporting of any kind
- **No cloud dependencies** — voice processing must remain local. Cloud features are opt-in only

## License

VOQR's core extension is MIT licensed. By contributing, you agree that your contributions will be licensed under the MIT License.

A `src/pro/` directory may be introduced in the future for proprietary Pro features under a separate license. This boundary will be clearly documented if and when it is created. Contributions to `src/pro/` (if it exists) require a separate agreement.

## Questions?

Open an issue — we respond to every one.
