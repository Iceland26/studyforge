// StudyForge headless smoke test.
// Serves dist/ locally, drives it with chrome-headless-shell (from the shared
// render-tools rig) through the full demo-mode flow:
//   load -> demo banner -> sample notes -> generate deck -> flip card ->
//   quiz to completion -> glossary -> tutor reply -> exam simulation.
// Exits non-zero on any failure. Screenshot: ../smoke.png
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const APP_DIR = fileURLToPath(new URL('..', import.meta.url));
const ROOT = join(APP_DIR, 'dist');
const BIN = '/home/hatch/workspace/makefun/render-tools/chs/chrome-headless-shell-linux64/chrome-headless-shell';
const require = createRequire('/home/hatch/workspace/makefun/render-tools/package.json');
const puppeteer = require('puppeteer-core');

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://127.0.0.1');
    let path = normalize(join(ROOT, decodeURIComponent(url.pathname)));
    if (url.pathname === '/') path = join(ROOT, 'index.html');
    if (!path.startsWith(ROOT)) { res.writeHead(403); return res.end(); }
    const data = await readFile(path);
    res.writeHead(200, { 'content-type': MIME[extname(path)] ?? 'application/octet-stream' });
    res.end(data);
  } catch {
    res.writeHead(404); res.end('nf');
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}/`;
console.log('serving', base);
if (!existsSync(BIN)) throw new Error('chrome-headless-shell binary missing at ' + BIN);

const failures = [];
const check = (name, ok, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`);
  if (!ok) failures.push(name);
};

const browser = await puppeteer.launch({
  executablePath: BIN,
  args: ['--no-sandbox', '--disable-gpu', '--hide-scrollbars'],
  defaultViewport: { width: 1440, height: 1000 },
});
try {
  const page = await browser.newPage();
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') pageErrors.push('console: ' + m.text()); });

  await page.goto(base, { waitUntil: 'load', timeout: 60000 });
  await page.waitForSelector('#generate-btn', { timeout: 15000 });

  check('demo banner visible (no Firebase config)', await page.$eval('#demo-banner', (el) => !el.hidden && el.textContent.includes('DEMO MODE')));
  check('mode pill says demo', await page.$eval('#mode-pill', (el) => el.textContent.toLowerCase().includes('demo')));

  // Sample notes + generate
  await page.click('#sample-btn');
  const notesLen = await page.$eval('#notes-input', (el) => el.value.length);
  check('sample notes loaded', notesLen > 500, `${notesLen} chars`);
  await page.click('#generate-btn');
  await page.waitForFunction(() => !document.querySelector('#deck-workspace').hidden, { timeout: 20000 });
  check('deck workspace appears after generation', true);
  const title = await page.$eval('#deck-title', (el) => el.textContent.trim());
  check('deck title rendered', title.length > 0, title);
  const badge = await page.$eval('#deck-source-badge', (el) => el.textContent);
  check('deck badge labels demo simulation', badge.toLowerCase().includes('demo'), badge);
  const counter1 = await page.$eval('#card-counter', (el) => el.textContent.trim());
  check('flashcard counter shows 1 / N', /^1 \/ [1-9]\d*$/.test(counter1), counter1);
  const frontText = await page.$eval('#card-front', (el) => el.textContent.trim());
  check('flashcard front has content', frontText.length > 10, frontText.slice(0, 60));

  await page.screenshot({ path: join(APP_DIR, 'smoke.png'), type: 'png' });
  console.log('screenshot saved: smoke.png');

  // Flip + navigate
  await page.click('#card-scene');
  check('card flips on click', await page.$eval('#flashcard', (el) => el.classList.contains('is-flipped')));
  await page.click('#next-card');
  const counter2 = await page.$eval('#card-counter', (el) => el.textContent.trim());
  check('next card advances counter', counter2.startsWith('2 /'), counter2);

  // Quiz to completion
  await page.click('.tab-btn[data-tab="quiz"]');
  await page.click('#quiz-start-btn');
  await page.waitForSelector('#quiz-options .option-btn', { timeout: 10000 });
  check('quiz renders options', (await page.$$('#quiz-options .option-btn')).length >= 3);
  for (let i = 0; i < 15; i++) {
    const done = await page.$eval('#quiz-result-view', (el) => !el.hidden);
    if (done) break;
    await page.click('#quiz-options .option-btn');
    await page.waitForFunction(() => !document.querySelector('#quiz-feedback').hidden, { timeout: 5000 });
    if (i === 0) check('quiz instant feedback shows', true);
    await page.click('#quiz-next-btn');
  }
  const scoreText = await page.$eval('#quiz-score-text', (el) => el.textContent.trim());
  check('quiz completes with score', /You scored \d+ \/ \d+/.test(scoreText), scoreText);

  // Glossary
  await page.click('.tab-btn[data-tab="glossary"]');
  const glossCount = await page.$$eval('#glossary-list .glossary-row', (rows) => rows.length);
  check('glossary has terms', glossCount >= 3, `${glossCount} terms`);

  // Tutor (demo reply) — the greeting is replaced by history once chatting
  // starts, so assert on the reply content itself.
  await page.click('.tab-btn[data-tab="tutor"]');
  await page.type('#tutor-input', 'What is the Calvin cycle?');
  await page.click('#tutor-form .btn-primary');
  await page.waitForFunction(
    () => [...document.querySelectorAll('#tutor-messages .chat-msg.assistant')]
      .some((el) => el.textContent.includes('demo simulator')),
    { timeout: 15000 },
  );
  check('tutor replies (demo simulator)', true);

  // Exam simulation (demo)
  await page.click('.tab-btn[data-tab="exam"]');
  await page.click('#exam-generate-btn');
  await page.waitForFunction(() => !document.querySelector('#exam-play-view').hidden, { timeout: 20000 });
  check('exam simulation starts', true);
  await page.click('#exam-options .option-btn');
  await page.waitForFunction(() => !document.querySelector('#exam-feedback').hidden, { timeout: 5000 });
  check('exam feedback shows explanation', await page.$eval('#exam-feedback', (el) => el.textContent.length > 10));

  // Persistence: reload and confirm the deck survives via localStorage
  await page.reload({ waitUntil: 'load' });
  await page.waitForFunction(() => !document.querySelector('#deck-workspace').hidden, { timeout: 15000 });
  check('deck persists across reload (localStorage)', true);

  check('no page errors', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));
} finally {
  await browser.close();
  server.close();
}

if (failures.length) {
  console.error(`\nSMOKE FAILED: ${failures.length} check(s): ${failures.join(', ')}`);
  process.exit(1);
}
console.log('\nSMOKE PASSED');
