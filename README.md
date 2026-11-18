# StudyForge

**Study decks forged on your device — not in someone else's cloud.**

StudyForge turns raw lecture notes into flashcards, a multiple-choice quiz,
and a glossary. Generation runs **on-device by default** — Gemini Nano inside
Chrome, orchestrated by **Firebase AI Logic hybrid inference** — so a
student's own notes are never uploaded just to make study material. The cloud
is used only for the two things an on-device model honestly cannot do in this
SDK: a multi-turn **Tutor** chat and a reasoning-heavy **Exam Simulation**.

Built for **#BuildHybridAI 2026** (Google × Firebase, Devpost).

**Live demo: https://studyforge-66d67.web.app**

## Why hybrid, and why this split

| Task | Where it runs | Why |
| --- | --- | --- |
| Flashcard / quiz / glossary generation | **On-device** (Gemini Nano, `PREFER_ON_DEVICE`) | Private by default, instant, works offline. Single-turn text generation + structured JSON output is exactly what the on-device leg supports. |
| Tutor chat | **Cloud** (`PREFER_IN_CLOUD`) | Multi-turn chat is not supported on-device in the Firebase AI Logic SDK — escalation is a technical necessity, and the UI says so openly. |
| Exam simulation | **Cloud** (`PREFER_IN_CLOUD`) | Mixed-topic, reasoning-grade questions with detailed grading explanations need the stronger cloud model and longer context. |
| Cloud fallback for generation | Cloud (automatic) | If the on-device model is unavailable (browser, flag, download), `PREFER_ON_DEVICE` falls back to the cloud model so the app never hard-fails. |

Every AI result carries the SDK's `inferenceSource` (`ON_DEVICE` / `IN_CLOUD`)
and the UI renders it as a visible **“Generated on-device” / “Generated in
cloud”** badge — the routing is part of the product, not a hidden detail. A
status bar shows the on-device model's state (ready / downloading /
unavailable) and the network state, and the app keeps working offline:
decks, flashcards, and quizzes are fully local.

## Architecture

```
┌──────────────────────────── StudyForge web app ────────────────────────────┐
│  index.html + src/main.js        UI: notes in → deck workspace              │
│  src/store.js                    decks in localStorage (local by default)   │
│  src/ai.js                       THE AI layer — the only Firebase caller    │
│      │                                                                      │
│      ├─ getGenerativeModel(mode: PREFER_ON_DEVICE,                          │
│      │     inCloudParams:  { model: gemini-3.5-flash-lite,                  │
│      │                      responseSchema (structured JSON) })             │
│      │     onDeviceParams: { createOptions.initialPrompts,                  │
│      │                      promptOptions.responseConstraint })             │
│      │        └─► Chrome Prompt API → Gemini Nano (on-device)               │
│      │        └─► fallback: Gemini Developer API (cloud)                    │
│      ├─ getGenerativeModel(mode: PREFER_IN_CLOUD)  → Tutor chat, Exam Sim   │
│      └─ src/demo-ai.js           local heuristic simulator, ONLY used       │
│                                  when no Firebase config exists (labelled)  │
│  App Check (debug provider in dev) initialized before AI Logic              │
└─────────────────────────────────────────────────────────────────────────────┘
```

Key implementation details:

- **Firebase JS SDK v13.x** (`firebase/ai`), backend = **Gemini Developer API**
  (`GoogleAIBackend`) so the project stays on the **free Spark plan** — no
  Blaze billing, no payment method. (Do not switch to the Agent Platform /
  Vertex backend: that forces Blaze.)
- `initializeDeviceModel()` is called from a user gesture (the Generate
  button / “Set up on-device model” button), with download progress surfaced
  in the status bar.
- Deck generation uses **structured output** on both legs: `responseSchema`
  for the cloud leg and the Prompt API's `responseConstraint` (plain JSON
  Schema) for the on-device leg; responses still pass through a
  repair-tolerant JSON parser (`src/json-utils.js`) before the UI trusts them.
- Long notes are chunked and merged; decks persist in `localStorage`.

## Run it locally (demo mode, no setup)

```bash
npm install
npm run dev        # http://127.0.0.1:5173
npm run build      # production build into dist/
npm run smoke      # headless end-to-end smoke test (needs the Chrome rig)
```

With no `.env`, the app runs in **DEMO MODE**: a banner and badges make it
unmistakable that generation is simulated locally with text heuristics — it is
**not** AI inference. Demo mode exists so the full UX can be exercised before
a Firebase project exists; it can never activate once real config is present.

## Connect the real Firebase project (owner, one-time)

1. **Create the project** at <https://console.firebase.google.com> — stay on
   the **Spark (no-cost)** plan.
2. **Enable AI Logic**: Firebase Console → *AI Logic* → *Get started* →
   choose the **Gemini Developer API** provider. This automatically enforces
   **App Check** for AI Logic.
3. **Register a Web app** in Project settings and copy its config values into
   `.env` (see `.env.example`): `VITE_FIREBASE_API_KEY`, `…_AUTH_DOMAIN`,
   `…_PROJECT_ID`, `…_STORAGE_BUCKET`, `…_MESSAGING_SENDER_ID`, `…_APP_ID`.
4. **App Check debug token**: run `npm run dev`, open the browser console and
   copy the App Check debug token the SDK prints, then register it in
   Firebase Console → *App Check* → *Apps* → *Manage debug tokens*.
   (Debug tokens are accepted in #BuildHybridAI submissions.)
5. Rebuild/restart — the demo banner disappears and the mode pill reads
   “Firebase AI Logic · live”. That config swap is the only change needed;
   all AI code already lives behind `src/ai.js`.

## Enable on-device inference (Chrome)

On-device generation requires **Chrome Desktop 139+** and the Prompt API flag:

1. Go to `chrome://flags/#prompt-api-for-gemini-nano-multimodal-input`, set it
   to **Enabled**, and restart Chrome.
2. Open StudyForge and click **“Set up on-device model”** (or just generate a
   deck). The first run downloads the Gemini Nano model (a few GB, one time);
   the status bar shows progress.
3. After that, deck generation shows the **“Generated on-device”** badge and
   keeps working with the network off (try DevTools → Network → Offline).

If the flag/model is unavailable, everything still works via the cloud
fallback — badges will say “Generated in cloud (fallback)”.

## Deploy (Firebase Hosting, Spark)

```bash
npm run build
npx firebase-tools deploy --only hosting   # uses firebase.json → dist/
```

## Project layout

```
index.html            App shell (all views)
src/main.js           UI controller, quiz/exam runners, tutor chat UI
src/ai.js             Firebase AI Logic hybrid layer (init, models, calls)
src/firebase-config.js  Env-driven config + placeholders (.env.example)
src/demo-ai.js        Local demo simulator (no-config fallback, labelled)
src/json-utils.js     Tolerant JSON parsing + deck/exam normalization
src/store.js          localStorage deck persistence
src/sample-notes.js   One-click sample lecture notes
scripts/smoke.mjs     Headless smoke test (puppeteer-core + headless Chrome)
```

## License

Apache License 2.0 — see [LICENSE](LICENSE).
