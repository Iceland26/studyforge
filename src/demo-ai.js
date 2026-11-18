// ---------------------------------------------------------------------------
// DEMO inference engine — LOCAL SIMULATION ONLY.
//
// This module exists so the StudyForge UI can be exercised end-to-end before
// the owner connects a real Firebase project. It performs NO AI inference:
// it builds a plausible deck from the notes with simple text heuristics
// (sentence splitting, cloze deletion, term spotting).
//
// The UI labels everything produced here with a "Demo simulation" badge, and
// src/ai.js only routes here when no Firebase config exists. The moment a
// real config is present, this module is never used.
// ---------------------------------------------------------------------------

import { normalizeDeck, normalizeExam } from './json-utils.js';

const STOP = new Set(('the a an and or of to in on for with by is are was were be been being this that these those it its as at from into than then so such can could may might will would should has have had not no yes if but or nor yet both each other more most many much own same only over under between through during before after').split(' '));

function splitSentences(text) {
  // Drop a leading heading line (no end punctuation) so it does not get
  // glued onto the first real sentence.
  const lines = text.split('\n');
  if (lines.length > 1 && lines[0].trim().length < 90 && !/[.!?]\s*$/.test(lines[0].trim())) {
    lines.shift();
    text = lines.join('\n');
  }
  return (text
    .replace(/\s+/g, ' ')
    .match(/[^.!?]+[.!?]+/g) || [])
    .map((s) => s.trim())
    .filter((s) => s.split(' ').length >= 6 && s.length <= 320);
}

function keyTerms(text) {
  const counts = new Map();
  // Capitalized phrases (incl. mid-sentence) and long content words.
  const phrases = text.match(/\b(?:[A-Z][a-z]+(?:\s+(?:of|the|and)\s+|\s+)?){1,3}[A-Z]?[a-z]*\b/g) || [];
  for (const p of phrases) {
    const t = p.trim();
    if (t.length >= 4 && t.length <= 28 && !STOP.has(t.toLowerCase())) counts.set(t, (counts.get(t) || 0) + 1);
  }
  const words = text.toLowerCase().match(/\b[a-z][a-z-]{5,}\b/g) || [];
  for (const w of words) if (!STOP.has(w)) counts.set(w, (counts.get(w) || 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([t]) => t);
}

function titleFromNotes(notes) {
  const firstLine = notes.split('\n').map((l) => l.trim()).find((l) => l.length > 3 && l.length < 80);
  return firstLine ? firstLine.replace(/^#+\s*/, '') : 'Study deck';
}

function buildDeckFromNotes(notes) {
  const sentences = splitSentences(notes);
  const terms = keyTerms(notes);
  const flashcards = [];
  const quiz = [];
  const usedTerms = new Set();

  for (const sentence of sentences) {
    if (flashcards.length >= 10) break;
    // Find the most salient term inside this sentence to blank out.
    const term = terms.find((t) => !usedTerms.has(t.toLowerCase()) && sentence.toLowerCase().includes(t.toLowerCase()));
    if (!term) continue;
    usedTerms.add(term.toLowerCase());
    const blanked = sentence.replace(new RegExp(escapeRegExp(term), 'i'), '_____');
    flashcards.push({
      front: `Fill in the blank: ${blanked}`,
      back: `${term} — ${sentence}`,
      tags: ['demo'],
      difficulty: 'medium',
    });
    if (quiz.length < 6) {
      const distractors = terms.filter((t) => t.toLowerCase() !== term.toLowerCase()).slice(0, 8);
      if (distractors.length >= 3) {
        const options = shuffle([term, ...pick(distractors, 3)]);
        quiz.push({
          question: `Which term completes this statement from your notes? "${blanked}"`,
          options,
          answerIndex: options.indexOf(term),
          explanation: `From your notes: "${sentence}"`,
        });
      }
    }
  }

  // Fallback cards if the notes were too short for cloze extraction.
  if (!flashcards.length && sentences.length) {
    sentences.slice(0, 5).forEach((s, i) => {
      flashcards.push({ front: `Key point ${i + 1} from your notes — what does it say?`, back: s, tags: ['demo'], difficulty: 'easy' });
    });
  }

  const glossary = terms.slice(0, 8).map((term) => {
    const def = sentences.find((s) => s.toLowerCase().includes(term.toLowerCase()));
    return { term, definition: def || 'Key term appearing in your notes.' };
  });

  return normalizeDeck({ title: titleFromNotes(notes), flashcards, quiz, glossary }, 'Study deck (demo)');
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
function pick(arr, n) {
  return shuffle(arr).slice(0, n);
}
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// --- Public surface (mirrors src/ai.js real-mode functions) -----------------

export async function demoGenerateDeck(notes) {
  await delay(650); // simulate generation latency so loading states are visible
  return { deck: buildDeckFromNotes(notes), source: 'DEMO' };
}

export async function demoGenerateExam(notes, deck) {
  await delay(650);
  const base = buildDeckFromNotes(notes);
  const questions = base.quiz.map((q) => ({ ...q, topic: deck?.title || 'Your notes' }));
  if (!questions.length) throw new Error('Add a few more sentences to your notes to simulate an exam.');
  return { exam: normalizeExam({ questions }), source: 'DEMO' };
}

export async function demoTutorReply(notes, _deck, history, question) {
  await delay(500);
  const sentences = splitSentences(notes || '');
  const words = question.toLowerCase().match(/\b[a-z]{4,}\b/g) || [];
  const hit = sentences.find((s) => words.some((w) => s.toLowerCase().includes(w)));
  const body = hit
    ? `Based on your notes: "${hit}"`
    : 'Your notes do not cover that directly yet — try asking about one of the key terms in the glossary.';
  return {
    text: `${body}\n\n(You are chatting with the local demo simulator, not an AI tutor — connect a Firebase project for the real cloud tutor.)`,
    source: 'DEMO',
  };
}
