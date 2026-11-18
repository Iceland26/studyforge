// ---------------------------------------------------------------------------
// StudyForge UI controller — wires the notes/deck workspace to src/ai.js.
// All AI calls go through the ai module; this file only renders results and
// displays each result's inference source as a badge.
// ---------------------------------------------------------------------------

import './styles.css';
import {
  MODE,
  generateDeck,
  generateExam,
  sendTutorMessage,
  probeDeviceAvailability,
  initializeOnDevice,
  onDeviceStateChange,
} from './ai.js';
import { loadDecks, addDeck, deleteDeck, getActiveDeck, setActiveDeckId } from './store.js';
import { SAMPLE_NOTES } from './sample-notes.js';

const $ = (id) => document.getElementById(id);
const els = {
  demoBanner: $('demo-banner'),
  modePill: $('mode-pill'),
  deviceDot: $('device-dot'),
  deviceText: $('device-text'),
  deviceSetupBtn: $('device-setup-btn'),
  netPill: $('net-pill'),
  error: $('app-error'),
  errorText: $('app-error-text'),
  notes: $('notes-input'),
  notesCount: $('notes-count'),
  generateBtn: $('generate-btn'),
  generateStatus: $('generate-status'),
  deckList: $('deck-list'),
  deckEmpty: $('deck-empty'),
  noDeck: $('no-deck-state'),
  workspace: $('deck-workspace'),
  deckTitle: $('deck-title'),
  deckSource: $('deck-source-badge'),
  flashcard: $('flashcard'),
  cardFront: $('card-front'),
  cardBack: $('card-back'),
  cardTags: $('card-tags'),
  cardDifficulty: $('card-difficulty'),
  cardCounter: $('card-counter'),
  glossaryList: $('glossary-list'),
  glossarySearch: $('glossary-search'),
  tutorMessages: $('tutor-messages'),
  tutorForm: $('tutor-form'),
  tutorInput: $('tutor-input'),
  tutorOffline: $('tutor-offline-note'),
  examOffline: $('exam-offline-note'),
  examStatus: $('exam-status'),
  toast: $('toast'),
};

// --- App state ---------------------------------------------------------------
let activeDeck = null;
let cardIndex = 0;
let cardFlipped = false;
let cardOrder = [];
const tutorHistories = new Map(); // deckId -> [{role, text, source}]

// --- Small helpers -----------------------------------------------------------
function showError(message) {
  els.errorText.textContent = message;
  els.error.hidden = false;
}
function hideError() { els.error.hidden = true; }
$('app-error-close').addEventListener('click', hideError);

let toastTimer;
function toast(message) {
  els.toast.textContent = message;
  els.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { els.toast.hidden = true; }, 4200);
}

function sourceBadge(source) {
  switch (source) {
    case 'ON_DEVICE': return { cls: 'badge-device', label: 'Generated on-device' };
    case 'IN_CLOUD': return { cls: 'badge-cloud', label: 'Generated in cloud (fallback)' };
    case 'MIXED': return { cls: 'badge-cloud', label: 'Generated hybrid — mixed on-device + cloud' };
    case 'DEMO': return { cls: 'badge-demo', label: 'Demo simulation — not AI inference' };
    default: return { cls: '', label: source || '' };
  }
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// --- Mode + hybrid status bar --------------------------------------------------
function renderMode() {
  if (MODE === 'demo') {
    els.demoBanner.hidden = false;
    els.modePill.textContent = 'Demo mode — no Firebase project';
    els.modePill.classList.add('pill-demo');
  } else {
    els.demoBanner.hidden = true;
    els.modePill.textContent = 'Firebase AI Logic · live';
  }
}

function renderDeviceState(state) {
  const dot = els.deviceDot;
  dot.className = 'dot';
  let text = '';
  let showSetup = false;
  switch (state.status) {
    case 'available':
      dot.classList.add('dot-available');
      text = 'On-device model: ready (Gemini Nano in Chrome) — generation is private & offline-capable';
      break;
    case 'downloading':
      dot.classList.add('dot-downloading');
      text = `On-device model: downloading… ${Math.round((state.progress || 0) * 100)}% (one-time, a few GB)`;
      break;
    case 'downloadable':
      dot.classList.add('dot-downloading');
      text = 'On-device model: ready to download';
      showSetup = true;
      break;
    case 'unavailable':
      dot.classList.add('dot-unavailable');
      text = MODE === 'demo'
        ? 'On-device model: n/a until a Firebase project is connected'
        : 'On-device model: not available in this browser (needs Chrome 139+ with the Prompt API flag) — cloud fallback active';
      showSetup = MODE !== 'demo';
      break;
    case 'demo':
      dot.classList.add('dot-demo');
      text = 'On-device model: n/a in demo mode';
      break;
    default:
      text = 'On-device model: checking…';
      showSetup = MODE !== 'demo';
  }
  els.deviceText.textContent = text;
  els.deviceSetupBtn.hidden = !showSetup;
}

els.deviceSetupBtn.addEventListener('click', async () => {
  els.deviceSetupBtn.disabled = true;
  await initializeOnDevice();
  els.deviceSetupBtn.disabled = false;
});

function renderNet() {
  const online = navigator.onLine;
  els.netPill.textContent = online ? 'Online' : 'Offline';
  els.netPill.classList.toggle('is-offline', !online);
  els.tutorOffline.hidden = online;
  els.examOffline.hidden = online;
}
window.addEventListener('online', renderNet);
window.addEventListener('offline', renderNet);

// --- Notes input ---------------------------------------------------------------
function updateNotesCount() {
  els.notesCount.textContent = `${els.notes.value.length.toLocaleString()} characters`;
  try { localStorage.setItem('studyforge.draftNotes', els.notes.value); } catch { /* ignore */ }
}
els.notes.addEventListener('input', updateNotesCount);
$('sample-btn').addEventListener('click', () => {
  els.notes.value = SAMPLE_NOTES;
  updateNotesCount();
  toast('Sample notes loaded — hit “Forge my study deck”.');
});
$('clear-notes-btn').addEventListener('click', () => {
  els.notes.value = '';
  updateNotesCount();
  els.notes.focus();
});

// --- Deck generation -------------------------------------------------------------
els.generateBtn.addEventListener('click', async () => {
  hideError();
  const notes = els.notes.value.trim();
  if (notes.length < 120) {
    showError('Your notes are too short — paste at least a few full sentences so there is something to study from.');
    return;
  }
  els.generateBtn.disabled = true;
  els.generateStatus.textContent = MODE === 'demo'
    ? 'Simulating generation locally (demo mode)…'
    : 'Forging your deck — on-device first, cloud only as fallback…';
  try {
    // First generation click doubles as the user gesture that initializes
    // the on-device model (required by the Firebase hybrid SDK).
    initializeOnDevice();
    const { deck, source } = await generateDeck(notes);
    const record = addDeck({ ...deck, notes, source });
    selectDeck(record.id);
    const badge = sourceBadge(source);
    toast(`Deck forged: ${deck.flashcards.length} flashcards · ${deck.quiz.length} quiz questions · ${deck.glossary.length} terms — ${badge.label.toLowerCase()}.`);
    els.generateStatus.textContent = '';
  } catch (err) {
    showError(err.message || 'Deck generation failed.');
    els.generateStatus.textContent = '';
  } finally {
    els.generateBtn.disabled = false;
  }
});

// --- Deck list / selection ---------------------------------------------------------
function renderDeckList() {
  const decks = loadDecks();
  els.deckEmpty.hidden = decks.length > 0;
  els.deckList.innerHTML = decks.map((d) => `
    <li class="deck-item ${activeDeck && d.id === activeDeck.id ? 'is-active' : ''}" data-deck-id="${escapeHtml(d.id)}">
      <span>
        <span class="deck-item-title">${escapeHtml(d.title)}</span><br />
        <span class="deck-item-meta">${(d.flashcards || []).length} cards · ${(d.quiz || []).length} questions · ${new Date(d.createdAt).toLocaleDateString()}</span>
      </span>
      <button class="btn btn-small btn-ghost deck-delete" data-delete="${escapeHtml(d.id)}" title="Delete deck">✕</button>
    </li>`).join('');
  els.deckList.querySelectorAll('.deck-item').forEach((item) => {
    item.addEventListener('click', () => selectDeck(item.dataset.deckId));
  });
  els.deckList.querySelectorAll('[data-delete]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      deleteDeck(btn.dataset.delete);
      if (activeDeck && activeDeck.id === btn.dataset.delete) activeDeck = getActiveDeck();
      renderAll();
    });
  });
}

function selectDeck(id) {
  setActiveDeckId(id);
  activeDeck = getActiveDeck();
  renderAll();
}

function renderAll() {
  renderDeckList();
  const has = Boolean(activeDeck);
  els.noDeck.hidden = has;
  els.workspace.hidden = !has;
  if (!has) return;
  els.deckTitle.textContent = activeDeck.title;
  const badge = sourceBadge(activeDeck.source);
  els.deckSource.className = `badge ${badge.cls}`;
  els.deckSource.textContent = badge.label;
  resetCardState();
  renderCard();
  resetQuiz();
  renderGlossary();
  renderTutor();
  resetExam();
}

// --- Tabs ---------------------------------------------------------------------------
document.querySelectorAll('.tab-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach((b) => b.classList.toggle('is-active', b === btn));
    for (const name of ['study', 'quiz', 'glossary', 'tutor', 'exam']) {
      $(`tab-${name}`).hidden = name !== btn.dataset.tab;
    }
  });
});

// --- Flashcards -----------------------------------------------------------------------
function resetCardState() {
  cardOrder = (activeDeck?.flashcards || []).map((_, i) => i);
  cardIndex = 0;
  cardFlipped = false;
}
function currentCard() {
  if (!activeDeck || !cardOrder.length) return null;
  return activeDeck.flashcards[cardOrder[cardIndex]];
}
function renderCard() {
  const card = currentCard();
  els.flashcard.classList.toggle('is-flipped', cardFlipped);
  if (!card) {
    els.cardFront.textContent = 'This deck has no flashcards.';
    els.cardBack.textContent = '';
    els.cardCounter.textContent = '0 / 0';
    return;
  }
  els.cardFront.textContent = card.front;
  els.cardBack.textContent = card.back;
  els.cardTags.textContent = (card.tags || []).map((t) => `#${t}`).join(' ');
  els.cardDifficulty.textContent = card.difficulty || '';
  els.cardCounter.textContent = `${cardIndex + 1} / ${cardOrder.length}`;
}
$('card-scene').addEventListener('click', () => {
  cardFlipped = !cardFlipped;
  renderCard();
});
$('prev-card').addEventListener('click', () => {
  if (!cardOrder.length) return;
  cardIndex = (cardIndex - 1 + cardOrder.length) % cardOrder.length;
  cardFlipped = false;
  renderCard();
});
$('next-card').addEventListener('click', () => {
  if (!cardOrder.length) return;
  cardIndex = (cardIndex + 1) % cardOrder.length;
  cardFlipped = false;
  renderCard();
});
$('shuffle-cards').addEventListener('click', () => {
  for (let i = cardOrder.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [cardOrder[i], cardOrder[j]] = [cardOrder[j], cardOrder[i]];
  }
  cardIndex = 0;
  cardFlipped = false;
  renderCard();
  toast('Flashcards shuffled.');
});

// --- Shared multiple-choice runner (quiz + exam) ---------------------------------------
function createMcqRunner(prefix, questions, { onFinish } = {}) {
  const state = { questions, idx: 0, score: 0, answered: false };
  const q = {
    start: $(`${prefix}-start-view`),
    play: $(`${prefix}-play-view`),
    result: $(`${prefix}-result-view`),
    progress: $(`${prefix}-progress`),
    question: $(`${prefix}-question`),
    options: $(`${prefix}-options`),
    feedback: $(`${prefix}-feedback`),
    next: $(`${prefix}-next-btn`),
    scoreText: $(`${prefix}-score-text`),
    live: $(`${prefix}-score-live`),
    topic: $(`${prefix}-topic`),
  };
  function show(view) {
    if (q.start) q.start.hidden = view !== 'start';
    q.play.hidden = view !== 'play';
    q.result.hidden = view !== 'result';
  }
  function renderQuestion() {
    const item = state.questions[state.idx];
    state.answered = false;
    q.progress.textContent = `Question ${state.idx + 1} of ${state.questions.length}`;
    if (q.live) q.live.textContent = `Score: ${state.score}`;
    if (q.topic) {
      q.topic.hidden = !item.topic;
      q.topic.textContent = item.topic || '';
    }
    q.question.textContent = item.question;
    q.feedback.hidden = true;
    q.next.hidden = true;
    q.options.innerHTML = '';
    item.options.forEach((opt, i) => {
      const btn = document.createElement('button');
      btn.className = 'option-btn';
      btn.innerHTML = `<span class="option-letter">${'ABCD'[i]}</span><span>${escapeHtml(opt)}</span>`;
      btn.addEventListener('click', () => answer(i));
      q.options.appendChild(btn);
    });
  }
  function answer(i) {
    if (state.answered) return;
    state.answered = true;
    const item = state.questions[state.idx];
    const correct = i === item.answerIndex;
    if (correct) state.score++;
    [...q.options.children].forEach((btn, bi) => {
      btn.disabled = true;
      if (bi === item.answerIndex) btn.classList.add('is-correct');
      else if (bi === i) btn.classList.add('is-wrong');
    });
    q.feedback.hidden = false;
    q.feedback.className = `feedback ${correct ? 'feedback-ok' : 'feedback-bad'}`;
    q.feedback.innerHTML = correct
      ? `<strong>Correct.</strong> ${escapeHtml(item.explanation || '')}`
      : `<strong>Not quite — the correct answer is ${'ABCD'[item.answerIndex]}.</strong> ${escapeHtml(item.explanation || '')}`;
    if (q.live) q.live.textContent = `Score: ${state.score}`;
    q.next.hidden = false;
    q.next.textContent = state.idx + 1 < state.questions.length ? 'Next question' : 'See results';
  }
  // onclick (not addEventListener): runners are rebuilt per deck/exam, and the
  // handler must be replaced — never stacked.
  q.next.onclick = () => {
    if (state.idx + 1 < state.questions.length) {
      state.idx++;
      renderQuestion();
    } else {
      q.scoreText.textContent = `You scored ${state.score} / ${state.questions.length}`;
      show('result');
      if (onFinish) onFinish(state);
    }
  };
  return {
    start() { state.idx = 0; state.score = 0; show('play'); renderQuestion(); },
    showStart() { show('start'); },
    showResult() { show('result'); },
    hasQuestions: () => state.questions.length > 0,
  };
}

let quizRunner = null;
function resetQuiz() {
  if (!activeDeck) return;
  quizRunner = createMcqRunner('quiz', activeDeck.quiz || []);
  $('quiz-meta').textContent = activeDeck.quiz?.length
    ? `${activeDeck.quiz.length} questions generated with your deck (${sourceBadge(activeDeck.source).label.toLowerCase()}). Instant feedback, no timer — learn as you go.`
    : 'This deck has no quiz questions.';
  $('quiz-start-btn').disabled = !activeDeck.quiz?.length;
  quizRunner.showStart();
}
$('quiz-start-btn').addEventListener('click', () => quizRunner && quizRunner.start());
$('quiz-restart-btn').addEventListener('click', () => quizRunner && quizRunner.start());

// --- Glossary ----------------------------------------------------------------------------
function renderGlossary() {
  const terms = activeDeck?.glossary || [];
  const filter = els.glossarySearch.value.trim().toLowerCase();
  const visible = terms.filter((g) => !filter || g.term.toLowerCase().includes(filter) || g.definition.toLowerCase().includes(filter));
  els.glossaryList.innerHTML = visible.length
    ? visible.map((g) => `<div class="glossary-row"><dt>${escapeHtml(g.term)}</dt><dd>${escapeHtml(g.definition)}</dd></div>`).join('')
    : '<p class="muted">No glossary terms match.</p>';
}
els.glossarySearch.addEventListener('input', renderGlossary);

// --- Tutor (cloud) ---------------------------------------------------------------------------
function tutorHistory() {
  if (!activeDeck) return [];
  if (!tutorHistories.has(activeDeck.id)) tutorHistories.set(activeDeck.id, []);
  return tutorHistories.get(activeDeck.id);
}
function renderTutor() {
  const history = tutorHistory();
  if (!history.length) {
    els.tutorMessages.innerHTML = `<div class="chat-msg assistant">Hi! I have your deck “${escapeHtml(activeDeck?.title || '')}” and your notes loaded. Ask me to explain a term, walk through a process, or test you verbally.</div>`;
    return;
  }
  els.tutorMessages.innerHTML = history.map((m) => {
    const badge = m.role === 'assistant' && m.source ? sourceBadge(m.source) : null;
    return `<div class="chat-msg ${m.role}">${escapeHtml(m.text)}${badge ? `<span class="badge ${badge.cls}">${badge.label === 'Demo simulation — not AI inference' ? 'Demo' : 'Cloud'}</span>` : ''}</div>`;
  }).join('');
  els.tutorMessages.scrollTop = els.tutorMessages.scrollHeight;
}
els.tutorForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!activeDeck) return;
  const question = els.tutorInput.value.trim();
  if (!question) return;
  if (!navigator.onLine && MODE !== 'demo') {
    showError('You are offline — the tutor needs the cloud. Flashcards and quiz still work.');
    return;
  }
  hideError();
  const history = tutorHistory();
  const prior = history.map(({ role, text }) => ({ role, text }));
  history.push({ role: 'user', text: question });
  els.tutorInput.value = '';
  els.tutorInput.disabled = true;
  renderTutor();
  const thinking = document.createElement('div');
  thinking.className = 'chat-msg assistant';
  thinking.textContent = MODE === 'demo' ? 'Simulating…' : 'Thinking (cloud)…';
  els.tutorMessages.appendChild(thinking);
  els.tutorMessages.scrollTop = els.tutorMessages.scrollHeight;
  try {
    const { text, source } = await sendTutorMessage(
      activeDeck.id,
      { notes: activeDeck.notes || '', deck: activeDeck },
      prior,
      question,
    );
    history.push({ role: 'assistant', text, source });
  } catch (err) {
    history.push({ role: 'assistant', text: `Sorry — the tutor could not answer just now. ${err.message || ''}`.trim(), source: null });
  } finally {
    els.tutorInput.disabled = false;
    renderTutor();
    els.tutorInput.focus();
  }
});

// --- Exam simulation (cloud) ---------------------------------------------------------------------
let examRunner = null;
function resetExam() {
  examRunner = null;
  $('exam-intro').hidden = false;
  $('exam-play-view').hidden = true;
  $('exam-result-view').hidden = true;
  els.examStatus.textContent = '';
}
$('exam-generate-btn').addEventListener('click', async () => {
  if (!activeDeck) return;
  if (!navigator.onLine && MODE !== 'demo') {
    showError('You are offline — exam simulation needs the cloud. Reconnect and try again.');
    return;
  }
  hideError();
  const btn = $('exam-generate-btn');
  btn.disabled = true;
  els.examStatus.textContent = MODE === 'demo' ? 'Simulating an exam locally (demo mode)…' : 'Generating a harder, mixed-topic exam in the cloud…';
  try {
    const { exam, source } = await generateExam(activeDeck.notes || '', activeDeck);
    examRunner = createMcqRunner('exam', exam.questions);
    $('exam-intro').hidden = true;
    toast(`Exam simulation ready — ${sourceBadge(source).label.toLowerCase()}.`);
    examRunner.start();
  } catch (err) {
    showError(err.message || 'Exam simulation failed.');
  } finally {
    btn.disabled = false;
    els.examStatus.textContent = '';
  }
});
$('exam-restart-btn').addEventListener('click', resetExam);

// --- Boot --------------------------------------------------------------------------------------------
function boot() {
  renderMode();
  onDeviceStateChange(renderDeviceState);
  probeDeviceAvailability();
  renderNet();
  try {
    const draft = localStorage.getItem('studyforge.draftNotes');
    if (draft) els.notes.value = draft;
  } catch { /* ignore */ }
  updateNotesCount();
  activeDeck = getActiveDeck();
  renderAll();
}
boot();
