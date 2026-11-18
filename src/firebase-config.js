// ---------------------------------------------------------------------------
// Firebase project configuration for StudyForge.
//
// Values come from Vite environment variables (see .env.example). Until the
// project owner creates the real Firebase project and fills in .env, these
// are PLACEHOLDERS and the app runs in its clearly-labelled local DEMO mode
// (see src/ai.js). Swapping in the real project is the ONLY change needed:
// put real values in .env, rebuild, done.
//
// Setup (owner, once): Firebase Console -> create project (Spark plan) ->
// AI Logic -> Get started -> choose "Gemini Developer API" (do NOT pick the
// Agent Platform / Vertex backend — that forces the Blaze billing plan) ->
// Project settings -> register a Web app -> copy the config here.
// ---------------------------------------------------------------------------

const env = import.meta.env ?? {};

export const firebaseConfig = {
  apiKey: env.VITE_FIREBASE_API_KEY || 'PLACEHOLDER_API_KEY',
  authDomain: env.VITE_FIREBASE_AUTH_DOMAIN || 'placeholder.firebaseapp.com',
  projectId: env.VITE_FIREBASE_PROJECT_ID || 'placeholder-project',
  storageBucket: env.VITE_FIREBASE_STORAGE_BUCKET || 'placeholder.appspot.com',
  messagingSenderId: env.VITE_FIREBASE_MESSAGING_SENDER_ID || '000000000000',
  appId: env.VITE_FIREBASE_APP_ID || '1:000000000000:web:placeholder',
};

/** Cloud model used for the fallback leg and for deliberate escalation. */
export const CLOUD_MODEL = env.VITE_CLOUD_MODEL || 'gemini-3.5-flash-lite';

/** Use the App Check debug provider (contest submissions accept debug tokens). */
export const APPCHECK_DEBUG = (env.VITE_APPCHECK_DEBUG ?? 'true') !== 'false';

/** True once a real project config has been supplied via .env. */
export const isFirebaseConfigured = Boolean(
  env.VITE_FIREBASE_API_KEY &&
    env.VITE_FIREBASE_PROJECT_ID &&
    env.VITE_FIREBASE_APP_ID &&
    !String(env.VITE_FIREBASE_API_KEY).startsWith('PLACEHOLDER') &&
    !String(env.VITE_FIREBASE_API_KEY).startsWith('YOUR_'),
);
