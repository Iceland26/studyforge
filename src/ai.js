// ---------------------------------------------------------------------------
// StudyForge AI layer — the ONLY module that talks to Firebase AI Logic.
//
// Hybrid architecture (per the #BuildHybridAI brief):
//   * Deck generation uses a HYBRID model with InferenceMode.PREFER_ON_DEVICE:
//     prompts run on-device with Gemini Nano (Chrome Prompt API) when it is
//     available and silently fall back to the cloud model when it is not.
//     Every response carries `inferenceSource` (ON_DEVICE / IN_CLOUD), which
//     the UI surfaces as a badge — the routing is visible, never hidden.
//   * Tutor chat and exam simulation deliberately ESCALATE to the cloud with
//     InferenceMode.PREFER_IN_CLOUD: multi-turn chat and long-context,
//     exam-grade reasoning are not supported on-device in this SDK, so the
//     cloud leg (default: gemini-3.5-flash-lite) is the honest tool for them.
//   * Backend is the Gemini Developer API (GoogleAIBackend) so the project
//     stays on the free Spark plan — no Blaze billing, no card.
//   * App Check is initialized before AI Logic (required by Firebase).
//     Production origins use the registered Fraud Defense (reCAPTCHA
//     Enterprise) provider; localhost keeps the debug provider (its token
//     is registered in the console).
//
// If no real Firebase config exists yet (src/firebase-config.js), every call
// routes to src/demo-ai.js, a local heuristic simulator, and results are
// labelled source: 'DEMO'. Demo mode can never activate once config exists.
// ---------------------------------------------------------------------------

import { initializeApp } from 'firebase/app';
import { initializeAppCheck, ReCaptchaEnterpriseProvider } from 'firebase/app-check';
import {
  getAI,
  getGenerativeModel,
  GoogleAIBackend,
  InferenceMode,
  Schema,
} from 'firebase/ai';

import { firebaseConfig, CLOUD_MODEL, APPCHECK_DEBUG, APPCHECK_SITE_KEY, isFirebaseConfigured } from './firebase-config.js';
import { parseModelJson, normalizeDeck, normalizeExam } from './json-utils.js';
import * as demo from './demo-ai.js';

export const MODE = isFirebaseConfigured ? 'firebase' : 'demo';

// ---------------------------------------------------------------------------
// Lazy Firebase initialization (only ever runs in firebase mode)
// ---------------------------------------------------------------------------
let app = null;
let ai = null;
let deckModel = null;
let cloudModel = null;
let deviceInitPromise = null;
let deviceState = { status: 'unknown', progress: 0 }; // unknown|unavailable|downloading|available|error
const deviceListeners = new Set();

function setDeviceState(next) {
  deviceState = { ...deviceState, ...next };
  for (const fn of deviceListeners) {
    try { fn(deviceState); } catch { /* listener errors are non-fatal */ }
  }
}
export function onDeviceStateChange(fn) {
  deviceListeners.add(fn);
  fn(deviceState);
  return () => deviceListeners.delete(fn);
}
export function getDeviceState() {
  return deviceState;
}

function ensureFirebase() {
  if (app) return { app, ai };
  app = initializeApp(firebaseConfig);

  // App Check MUST be initialized before AI Logic calls. On localhost we
  // keep the debug provider: setting FIREBASE_APPCHECK_DEBUG_TOKEN makes
  // the SDK mint a debug token (registered in Firebase Console -> App
  // Check -> Manage debug tokens) and it takes precedence over the
  // configured provider. On every other origin the debug global is never
  // set, so the production Fraud Defense (reCAPTCHA Enterprise) provider
  // runs with the registered site key.
  const isLocalhost = ['localhost', '127.0.0.1', '[::1]'].includes(self.location?.hostname ?? '');
  if (APPCHECK_DEBUG && isLocalhost) {
    self.FIREBASE_APPCHECK_DEBUG_TOKEN = true;
  }
  try {
    initializeAppCheck(app, {
      provider: new ReCaptchaEnterpriseProvider(APPCHECK_SITE_KEY),
      isTokenAutoRefreshEnabled: true,
    });
  } catch (err) {
    // App Check init failure should not brick the app shell; AI calls will
    // surface the real error. Log for the developer.
    console.warn('[StudyForge] App Check initialization warning:', err);
  }

  ai = getAI(app, { backend: new GoogleAIBackend() });
  return { app, ai };
}

const SYSTEM_PROMPT =
  'You are StudyForge, an expert study-material generator. You turn raw lecture notes into precise, exam-ready study material. You always respond with a single valid JSON object and nothing else.';

// NOTE on hybrid params (verified against firebase@13.4 SDK source): when a
// hybrid `mode` is set, getGenerativeModel IGNORES any top-level ModelParams
// keys — cloud config must live in `inCloudParams`, on-device config in
// `onDeviceParams`. Structured output on-device goes through the Prompt API's
// `responseConstraint` (a plain JSON Schema) via onDeviceParams.promptOptions.
function getDeckModel() {
  if (deckModel) return deckModel;
  const { ai: aiInstance } = ensureFirebase();
  deckModel = getGenerativeModel(aiInstance, {
    mode: InferenceMode.PREFER_ON_DEVICE,
    inCloudParams: {
      model: CLOUD_MODEL,
      systemInstruction: SYSTEM_PROMPT,
      generationConfig: {
        temperature: 0.4,
        maxOutputTokens: 4096,
        responseMimeType: 'application/json',
        responseSchema: buildDeckSchema(),
      },
    },
    onDeviceParams: {
      createOptions: {
        initialPrompts: [{ role: 'system', content: SYSTEM_PROMPT }],
        expectedInputs: [{ type: 'text', languages: ['en'] }],
        expectedOutputs: [{ type: 'text', languages: ['en'] }],
      },
      promptOptions: { responseConstraint: DECK_JSON_SCHEMA },
    },
  });
  return deckModel;
}

function getCloudModel() {
  if (cloudModel) return cloudModel;
  const { ai: aiInstance } = ensureFirebase();
  cloudModel = getGenerativeModel(aiInstance, {
    mode: InferenceMode.PREFER_IN_CLOUD,
    inCloudParams: {
      model: CLOUD_MODEL,
      generationConfig: { temperature: 0.6, maxOutputTokens: 4096 },
    },
  });
  return cloudModel;
}

/** Plain JSON Schema for the on-device Prompt API responseConstraint. */
const DECK_JSON_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    flashcards: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          front: { type: 'string' },
          back: { type: 'string' },
          tags: { type: 'array', items: { type: 'string' } },
          difficulty: { type: 'string', enum: ['easy', 'medium', 'hard'] },
        },
        required: ['front', 'back'],
      },
    },
    quiz: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          question: { type: 'string' },
          options: { type: 'array', items: { type: 'string' } },
          answerIndex: { type: 'integer' },
          explanation: { type: 'string' },
        },
        required: ['question', 'options', 'answerIndex'],
      },
    },
    glossary: {
      type: 'array',
      items: {
        type: 'object',
        properties: { term: { type: 'string' }, definition: { type: 'string' } },
        required: ['term', 'definition'],
      },
    },
  },
  required: ['flashcards', 'quiz', 'glossary'],
};

function buildDeckSchema() {
  // Structured output is supported on-device; use the SDK Schema helpers.
  // If a future SDK changes the helper surface, fall back to prompt-only JSON.
  try {
    return Schema.object({
      properties: {
        title: Schema.string(),
        flashcards: Schema.array({
          items: Schema.object({
            properties: {
              front: Schema.string(),
              back: Schema.string(),
              tags: Schema.array({ items: Schema.string() }),
              difficulty: Schema.enumString({ enum: ['easy', 'medium', 'hard'] }),
            },
            optionalProperties: ['tags', 'difficulty'],
          }),
        }),
        quiz: Schema.array({
          items: Schema.object({
            properties: {
              question: Schema.string(),
              options: Schema.array({ items: Schema.string() }),
              answerIndex: Schema.integer(),
              explanation: Schema.string(),
            },
            optionalProperties: ['explanation'],
          }),
        }),
        glossary: Schema.array({
          items: Schema.object({
            properties: { term: Schema.string(), definition: Schema.string() },
          }),
        }),
      },
      optionalProperties: ['title'],
    });
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// On-device model lifecycle
// ---------------------------------------------------------------------------

/**
 * Report Chrome Prompt API availability where the raw API is visible.
 * Returns 'available' | 'downloadable' | 'downloading' | 'unavailable' | 'unknown'.
 * The Firebase SDK remains the source of truth at generation time; this is
 * for the status bar.
 */
export async function probeDeviceAvailability() {
  if (MODE === 'demo') {
    setDeviceState({ status: 'demo' });
    return deviceState;
  }
  try {
    const LM = globalThis.LanguageModel;
    if (LM && typeof LM.availability === 'function') {
      const a = await LM.availability();
      if (a === 'available') setDeviceState({ status: 'available', progress: 1 });
      else if (a === 'downloadable') setDeviceState({ status: 'downloadable', progress: 0 });
      else if (a === 'downloading') setDeviceState({ status: 'downloading' });
      else setDeviceState({ status: 'unavailable' });
    } else {
      // Prompt API not exposed (non-Chrome / flag off): the SDK will fall
      // back to cloud; mark as unavailable-for-now rather than an error.
      setDeviceState({ status: 'unavailable' });
    }
  } catch {
    setDeviceState({ status: 'unavailable' });
  }
  return deviceState;
}

/**
 * Trigger the one-time on-device model download/initialization.
 * MUST be called from a user gesture (button click) per Firebase docs.
 * Safe to call repeatedly; concurrent calls share one promise.
 */
export function initializeOnDevice() {
  if (MODE === 'demo') return Promise.resolve(deviceState);
  if (deviceInitPromise) return deviceInitPromise;
  deviceInitPromise = (async () => {
    try {
      setDeviceState({ status: 'downloading', progress: 0 });
      const model = getDeckModel();
      if (typeof model.initializeDeviceModel === 'function') {
        await model.initializeDeviceModel((progress) => {
          const p = typeof progress === 'number' ? progress : progress?.progress ?? 0;
          setDeviceState({ status: p >= 1 ? 'available' : 'downloading', progress: p });
        });
      }
      await probeDeviceAvailability();
      if (deviceState.status === 'downloading') setDeviceState({ status: 'available', progress: 1 });
    } catch (err) {
      console.warn('[StudyForge] On-device initialization failed; cloud fallback remains active.', err);
      setDeviceState({ status: 'unavailable' });
    } finally {
      deviceInitPromise = null;
    }
    return deviceState;
  })();
  return deviceInitPromise;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sourceOf(result) {
  const raw = result?.response?.inferenceSource;
  if (!raw) return 'IN_CLOUD';
  const s = String(raw).toUpperCase();
  return s.includes('DEVICE') ? 'ON_DEVICE' : 'IN_CLOUD';
}

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${Math.round(ms / 1000)}s. If this was the first on-device run, the model may still be downloading — check the status bar and try again.`)), ms)),
  ]);
}

function friendlyError(err) {
  const msg = err?.message || String(err);
  if (/app ?check/i.test(msg)) return 'App Check blocked this call. If you are running locally, register this browser\'s debug token in Firebase Console -> App Check -> Manage debug tokens, then reload.';
  // NOTE: match "rate limit" as a phrase — a bare /rate/ also matches
  // "generate" in SDK endpoint URLs and mislabels unrelated errors.
  if (/quota|429|rate[- ]?limit|RESOURCE_EXHAUSTED/i.test(msg)) return 'The cloud model is rate-limited right now (free-tier quota). Wait a moment and try again — on-device generation is unaffected.';
  if (/offline|network|fetch/i.test(msg)) return 'Network error. If you are offline, on-device generation still works; cloud features need a connection.';
  return msg;
}

function chunkNotes(notes, maxChars = 3500) {
  const paragraphs = notes.split(/\n\s*\n/);
  const chunks = [];
  let current = '';
  for (const p of paragraphs) {
    if ((current + '\n\n' + p).length > maxChars && current) {
      chunks.push(current);
      current = p;
    } else {
      current = current ? current + '\n\n' + p : p;
    }
    while (current.length > maxChars * 1.6) {
      chunks.push(current.slice(0, maxChars));
      current = current.slice(maxChars);
    }
  }
  if (current.trim()) chunks.push(current);
  return chunks.slice(0, 4); // cap work per generation
}

const DECK_PROMPT = (chunk, part, total) => `Turn the lecture notes below into study material${total > 1 ? ` (part ${part} of ${total} — cover only this part)` : ''}.

Return ONE JSON object with exactly this shape:
{
  "title": "short deck title based on the notes",
  "flashcards": [ { "front": "question or prompt", "back": "concise answer", "tags": ["topic"], "difficulty": "easy|medium|hard" } ],
  "quiz": [ { "question": "multiple-choice question", "options": ["A", "B", "C", "D"], "answerIndex": 0, "explanation": "why the answer is correct" } ],
  "glossary": [ { "term": "key term", "definition": "clear one-sentence definition" } ]
}

Rules: 6-10 flashcards, 4-6 quiz questions with exactly 4 options each and plausible distractors taken from the notes, 5-8 glossary terms. Base everything strictly on the notes. No markdown, no prose outside the JSON.

NOTES:
"""
${chunk}
"""`;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Generate a study deck. On-device by default (hybrid PREFER_ON_DEVICE). */
export async function generateDeck(notes) {
  if (MODE === 'demo') return demo.demoGenerateDeck(notes);
  const model = getDeckModel();
  const chunks = chunkNotes(notes);
  const sources = new Set();
  const merged = { title: '', flashcards: [], quiz: [], glossary: [] };
  const seenTerms = new Set();

  for (let i = 0; i < chunks.length; i++) {
    let result;
    try {
      result = await withTimeout(model.generateContent(DECK_PROMPT(chunks[i], i + 1, chunks.length)), 120000, 'Deck generation');
    } catch (err) {
      throw new Error(friendlyError(err));
    }
    sources.add(sourceOf(result));
    const part = normalizeDeck(parseModelJson(result.response.text()), 'Study deck');
    if (!merged.title) merged.title = part.title;
    merged.flashcards.push(...part.flashcards);
    merged.quiz.push(...part.quiz);
    for (const g of part.glossary) {
      const key = g.term.toLowerCase();
      if (!seenTerms.has(key)) { seenTerms.add(key); merged.glossary.push(g); }
    }
  }
  merged.flashcards = merged.flashcards.slice(0, 24);
  merged.quiz = merged.quiz.slice(0, 12);
  merged.glossary = merged.glossary.slice(0, 20);
  const source = sources.size > 1 ? 'MIXED' : [...sources][0] || 'IN_CLOUD';
  return { deck: merged, source };
}

/** Generate an exam simulation (cloud escalation: harder, mixed, explained). */
export async function generateExam(notes, deck) {
  if (MODE === 'demo') return demo.demoGenerateExam(notes, deck);
  const model = getCloudModel();
  const prompt = `You are an exam setter. Using the study material below, write a challenging exam simulation: 6 multiple-choice questions that mix topics, require reasoning (not pure recall), and include common misconceptions as distractors.

Return ONE JSON object: { "questions": [ { "question": "...", "options": ["A","B","C","D"], "answerIndex": 0, "explanation": "detailed explanation of the correct answer and why the main distractor is wrong", "topic": "topic name" } ] }
No markdown, no prose outside the JSON.

DECK TITLE: ${deck?.title || 'Study deck'}
KEY TERMS: ${(deck?.glossary || []).map((g) => g.term).join(', ') || '(none)'}

NOTES:
"""
${(notes || '').slice(0, 9000)}
"""`;
  let result;
  try {
    // Per-request JSON config: the shared cloud model must stay plain-text
    // for tutor chat, so structured output is requested per-call here.
    result = await withTimeout(
      model.generateContent({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: { responseMimeType: 'application/json', temperature: 0.6, maxOutputTokens: 4096 },
      }),
      120000,
      'Exam simulation',
    );
  } catch (err) {
    throw new Error(friendlyError(err));
  }
  return { exam: normalizeExam(parseModelJson(result.response.text())), source: sourceOf(result) };
}

// Tutor sessions are kept per context so follow-up questions keep context.
// Multi-turn chat is cloud-only in this SDK — that is precisely why the
// tutor lives on the PREFER_IN_CLOUD model.
const tutorSessions = new Map();

export function resetTutorSession(key) {
  tutorSessions.delete(key);
}

export async function sendTutorMessage(key, context, history, question) {
  if (MODE === 'demo') return demo.demoTutorReply(context.notes, context.deck, history, question);
  let session = tutorSessions.get(key);
  if (!session) {
    const model = getCloudModel();
    const priming = [
      {
        role: 'user',
        parts: [{
          text: `You are the StudyForge tutor. A student is studying the material below. Answer questions about it clearly and concisely, give examples where helpful, and stay grounded in the material; if asked something outside it, say so briefly and still try to help.

DECK: ${context.deck?.title || 'Study deck'}
GLOSSARY: ${(context.deck?.glossary || []).map((g) => `${g.term}: ${g.definition}`).join(' | ') || '(none)'}

NOTES:
"""
${(context.notes || '').slice(0, 9000)}
"""`,
        }],
      },
      { role: 'model', parts: [{ text: 'Got it — I have your notes and deck loaded. Ask me anything about this material.' }] },
    ];
    // Replay any prior visible history (e.g., after a page reload).
    for (const m of history || []) {
      priming.push({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.text }] });
      if (m.role !== 'assistant') priming.push({ role: 'model', parts: [{ text: 'Understood.' }] });
    }
    session = model.startChat({ history: priming });
    tutorSessions.set(key, session);
  }
  let result;
  try {
    result = await withTimeout(session.sendMessage(question), 90000, 'Tutor reply');
  } catch (err) {
    tutorSessions.delete(key);
    throw new Error(friendlyError(err));
  }
  return { text: result.response.text(), source: sourceOf(result) };
}
