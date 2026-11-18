// ---------------------------------------------------------------------------
// Robust JSON extraction / repair + payload normalization.
//
// On-device models occasionally wrap JSON in code fences, add prose, emit
// trailing commas, or truncate the final array element. Generation is useless
// to the UI unless it parses, so every model response goes through here
// before it is trusted.
// ---------------------------------------------------------------------------

/** Extract and parse the first JSON object found in a model response. */
export function parseModelJson(text) {
  if (typeof text !== 'string' || !text.trim()) {
    throw new Error('The model returned an empty response.');
  }
  let candidate = text.trim();

  // Strip markdown code fences if present.
  const fence = candidate.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) candidate = fence[1].trim();

  // Find the outermost object.
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) {
    throw new Error('The model response did not contain a JSON object.');
  }
  candidate = candidate.slice(start, end + 1);

  const attempts = [
    candidate,
    repairJson(candidate),
    repairJson(truncateToLastComplete(candidate)),
  ];
  let lastError;
  for (const attempt of attempts) {
    try {
      return JSON.parse(attempt);
    } catch (err) {
      lastError = err;
    }
  }
  throw new Error(`Could not parse the model's JSON output (${lastError?.message ?? 'unknown error'}).`);
}

function repairJson(s) {
  return s
    // Remove trailing commas before } or ]
    .replace(/,\s*([}\]])/g, '$1')
    // Replace smart quotes with straight quotes
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'");
}

/** Cut a truncated JSON string back to the last complete array element. */
function truncateToLastComplete(s) {
  const lastObj = s.lastIndexOf('},');
  if (lastObj === -1) return s;
  let cut = s.slice(0, lastObj + 1);
  // Close any open arrays/objects naively but deterministically.
  const opens = (cut.match(/[{[]/g) || []).length;
  const closes = (cut.match(/[}\]]/g) || []).length;
  for (let i = 0; i < opens - closes; i++) {
    // Guess the closer from the last unclosed opener.
    const lastOpen = Math.max(cut.lastIndexOf('{'), cut.lastIndexOf('['));
    cut += cut[lastOpen] === '{' ? '}' : ']';
  }
  return cut;
}

const asString = (v) => (typeof v === 'string' ? v.trim() : v == null ? '' : String(v).trim());

/**
 * Normalize a deck payload into the shape the UI uses, dropping malformed
 * entries instead of failing the whole generation.
 * Expected: { title, flashcards:[{front,back,tags,difficulty}],
 *             quiz:[{question,options:[4],answerIndex,explanation}],
 *             glossary:[{term,definition}] }
 */
export function normalizeDeck(raw, fallbackTitle = 'Untitled deck') {
  if (!raw || typeof raw !== 'object') throw new Error('Deck payload was not an object.');

  const flashcards = (Array.isArray(raw.flashcards) ? raw.flashcards : [])
    .map((c) => ({
      front: asString(c?.front),
      back: asString(c?.back),
      tags: Array.isArray(c?.tags) ? c.tags.map(asString).filter(Boolean).slice(0, 4) : [],
      difficulty: ['easy', 'medium', 'hard'].includes(c?.difficulty) ? c.difficulty : 'medium',
    }))
    .filter((c) => c.front && c.back);

  const quiz = (Array.isArray(raw.quiz) ? raw.quiz : [])
    .map((q) => {
      const options = (Array.isArray(q?.options) ? q.options : []).map(asString).filter(Boolean).slice(0, 4);
      let answerIndex = Number.isInteger(q?.answerIndex) ? q.answerIndex : -1;
      // Some models emit the answer text instead of an index.
      if ((answerIndex < 0 || answerIndex >= options.length) && typeof q?.answer === 'string') {
        answerIndex = options.findIndex((o) => o.toLowerCase() === q.answer.trim().toLowerCase());
      }
      return {
        question: asString(q?.question),
        options,
        answerIndex,
        explanation: asString(q?.explanation),
      };
    })
    .filter((q) => q.question && q.options.length >= 3 && q.answerIndex >= 0 && q.answerIndex < q.options.length);

  const glossary = (Array.isArray(raw.glossary) ? raw.glossary : [])
    .map((g) => ({ term: asString(g?.term), definition: asString(g?.definition) }))
    .filter((g) => g.term && g.definition);

  if (!flashcards.length && !quiz.length && !glossary.length) {
    throw new Error('The model returned a deck with no usable cards, questions, or terms.');
  }
  return { title: asString(raw.title) || fallbackTitle, flashcards, quiz, glossary };
}

/** Normalize an exam-simulation payload: { questions: [...] } with explanations. */
export function normalizeExam(raw) {
  const questions = (Array.isArray(raw?.questions) ? raw.questions : [])
    .map((q) => {
      const options = (Array.isArray(q?.options) ? q.options : []).map(asString).filter(Boolean).slice(0, 4);
      let answerIndex = Number.isInteger(q?.answerIndex) ? q.answerIndex : -1;
      if ((answerIndex < 0 || answerIndex >= options.length) && typeof q?.answer === 'string') {
        answerIndex = options.findIndex((o) => o.toLowerCase() === q.answer.trim().toLowerCase());
      }
      return {
        question: asString(q?.question),
        options,
        answerIndex,
        explanation: asString(q?.explanation),
        topic: asString(q?.topic),
      };
    })
    .filter((q) => q.question && q.options.length >= 3 && q.answerIndex >= 0 && q.answerIndex < q.options.length);
  if (!questions.length) throw new Error('The exam simulation came back with no usable questions.');
  return { questions };
}
