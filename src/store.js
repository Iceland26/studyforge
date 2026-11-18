// ---------------------------------------------------------------------------
// Local persistence — decks live in localStorage on the student's own machine.
// That is a product feature, not just plumbing: in StudyForge your notes and
// decks are local by default, matching the on-device generation story.
// ---------------------------------------------------------------------------

const KEY = 'studyforge.decks.v1';
const ACTIVE_KEY = 'studyforge.activeDeckId.v1';

export function loadDecks() {
  try {
    const raw = localStorage.getItem(KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function saveDecks(decks) {
  try {
    localStorage.setItem(KEY, JSON.stringify(decks));
  } catch {
    // Storage full/blocked — the in-memory deck still works for this session.
  }
}

export function addDeck(deck) {
  const decks = loadDecks();
  const record = {
    id: `deck-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    createdAt: new Date().toISOString(),
    ...deck,
  };
  decks.unshift(record);
  saveDecks(decks.slice(0, 20));
  setActiveDeckId(record.id);
  return record;
}

export function deleteDeck(id) {
  saveDecks(loadDecks().filter((d) => d.id !== id));
  if (getActiveDeckId() === id) setActiveDeckId(null);
}

export function getActiveDeckId() {
  try { return localStorage.getItem(ACTIVE_KEY); } catch { return null; }
}
export function setActiveDeckId(id) {
  try {
    if (id) localStorage.setItem(ACTIVE_KEY, id);
    else localStorage.removeItem(ACTIVE_KEY);
  } catch { /* non-fatal */ }
}

export function getActiveDeck() {
  const decks = loadDecks();
  const id = getActiveDeckId();
  return decks.find((d) => d.id === id) || decks[0] || null;
}
