RealtimeJaEnTranslator v5 fix

IMPORTANT:
1) Upload assets/app.js and sw.js to the GitHub repository root, overwriting existing files.
2) _CloudflareWorker/worker.js is NOT deployed by GitHub Pages. Open the Cloudflare Worker editor, replace worker.js with this file, then Deploy.
3) Reload GitHub Pages with Ctrl+F5. Old test rows are intentionally hidden by moving to a new localStorage key.

Why the Worker update is necessary:
The current ephemeral token contains the whole bidiGenerateContentSetup with an empty field mask. In that configuration Gemini ignores the setup sent by the browser. Therefore VAD settings added only to app.js never took effect.
The new Worker constrains only the model via fieldMask=model. Browser-side language, dictionary, translation and VAD settings are then applied.

VAD:
- endOfSpeechSensitivity: HIGH
- silenceDurationMs: 650
- prefixPaddingMs: 200

Row boundary:
- turnComplete is primary boundary
- finalized inputTranscription is not concatenated across utterances
- 1.6 second fallback is used only if turnComplete is not delivered
