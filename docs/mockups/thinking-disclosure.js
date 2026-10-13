// Standalone simulation only. No model calls, persistence, or plugin integration.
const paths = {
  infinity: '<path d="M6 16c5 0 7-8 12-8a4 4 0 0 1 0 8c-5 0-7-8-12-8a4 4 0 0 0 0 8Z"/>',
  brain: '<path d="M12 18V5"/><path d="M15 13a4.17 4.17 0 0 1-3-4 4.17 4.17 0 0 1-3 4"/><path d="M17.598 6.5A3 3 0 1 0 12 5a3 3 0 1 0-5.598 1.5"/><path d="M17.997 5.125a4 4 0 0 1 2.526 5.77"/><path d="M18 18a4 4 0 0 0 2-7.464"/><path d="M19.967 17.483A4 4 0 1 1 12 18a4 4 0 1 1-7.967-.517"/><path d="M6 18a4 4 0 0 1-2-7.464"/><path d="M6.003 5.125a4 4 0 0 0-2.526 5.77"/>',
  'chevron-right': '<path d="m9 6 6 6-6 6"/>',
  sparkles: '<path d="m12 3 2.4 6.6L21 12l-6.6 2.4L12 21l-2.4-6.6L3 12l6.6-2.4L12 3Z"/>',
  lightbulb: '<path d="M9 18h6m-5 3h4M9 15a6 6 0 1 1 6 0v3H9Z"/>',
  'git-branch': '<circle cx="6" cy="5" r="3"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="19" r="3"/><path d="M6 8v8m12-7a10 10 0 0 1-12 7"/>',
  'arrow-down': '<path d="M12 5v14m-6-6 6 6 6-6"/>',
  square: '<rect x="5" y="5" width="14" height="14" rx="2"/>',
};
function icon(el, name) {
  el.dataset.icon = name;
  el.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${paths[name]}</svg>`;
}
document.querySelectorAll('[data-icon]').forEach(el => icon(el, el.dataset.icon));
const $ = id => document.getElementById(id);
const row = $('thinking-toggle');
const panel = $('thinking-panel');
const content = $('thinking-content');
const shell = document.querySelector('.message-reasoning');
const loader = document.querySelector('.thinking-loader');
const word = document.querySelector('.thinking-loader-text');
const glyph = document.querySelector('.thinking-loader-icon');
const reduced = matchMedia('(prefers-reduced-motion: reduce)');
const samples = [
  'I’ll look for the ideas that recur across these notes, then separate the shared themes from the details specific to each project.',
  'A useful starting point is the relationship between collecting information and deciding what to do next. The notes seem to approach that same question from different directions.',
  'I’ll compare the project summaries with their open questions. That should help distinguish a real connection from two notes that happen to use similar words.',
  'The next step is to anchor each connection to a source note, so the overview stays useful when you return to the original material.',
  'I can group the result into shared themes, tensions worth exploring, and small next actions. Each group should point back to the notes that support it.'
];
const fullText = samples.join('\n\n');
const words = [['Contemplating', 'infinity'], ['Pondering', 'lightbulb'], ['Weaving', 'git-branch'], ['Musing', 'sparkles']];
let state = 'live';
let streamTimer;
let wordTimer;
let offset = 0;
let wordIndex = 0;
let following = true;
let readingPosition = 0;
const followButton = $('thinking-follow');
function atBottom() {
  return content.scrollHeight - content.scrollTop - content.clientHeight <= 8;
}
function updateFollowButton() {
  followButton.hidden = following || atBottom();
}
function jumpToLatest() {
  following = true;
  content.scrollTop = content.scrollHeight;
  readingPosition = content.scrollTop;
  updateFollowButton();
}
function label(text, name, animated = false) {
  icon(glyph, name);
  word.textContent = text + (animated ? '…' : '');
  loader.classList.remove('is-changing');
  if (animated && !reduced.matches) {
    void loader.offsetWidth;
    loader.classList.add('is-changing');
  }
}
function syncDisclosure() {
  const open = row.getAttribute('aria-expanded') === 'true';
  panel.hidden = !open;
  // aria-expanded supplies the accordion state without extra visible labels.
  row.setAttribute('aria-label', state === 'done' ? 'Reasoning' : 'Thinking');
  if (open) {
    content.scrollTop = following ? content.scrollHeight : readingPosition;
    updateFollowButton();
  }
}
row.addEventListener('click', () => {
  if (!panel.hidden) readingPosition = content.scrollTop;
  row.setAttribute('aria-expanded', String(row.getAttribute('aria-expanded') !== 'true'));
  syncDisclosure();
});
function startWords() {
  label(...words[0], true);
  wordTimer = setInterval(() => {
    if (reduced.matches) return;
    wordIndex = (wordIndex + 1) % words.length;
    label(...words[wordIndex], true);
  }, 5000);
}
function stream() {
  // Measure before appending. A new chunk must not make a caught-up reader
  // appear to have scrolled away. Ignore hidden geometry while folded.
  if (!panel.hidden) following = atBottom();
  const previousOffset = offset;
  offset = Math.min(offset + 28, fullText.length);
  content.append(document.createTextNode(fullText.slice(previousOffset, offset)));
  if (!panel.hidden) {
    if (following) jumpToLatest();
    else updateFollowButton();
  }
  if (offset === fullText.length) clearInterval(streamTimer);
}
content.addEventListener('scroll', () => {
  if (panel.hidden) return;
  following = atBottom();
  readingPosition = content.scrollTop;
  updateFollowButton();
});
followButton.addEventListener('click', () => {
  jumpToLatest();
  content.focus({ preventScroll: true });
});
new ResizeObserver(() => {
  if (panel.hidden) return;
  if (following || atBottom()) jumpToLatest();
  else updateFollowButton();
}).observe(content);
const notes = {
  live: 'Open the accordion to watch sample thinking arrive. Scroll up to pause following; return to the bottom or use the arrow to follow again.',
  waiting: 'The same row is clickable immediately. Its empty panel explains that thinking has not arrived yet.',
  done: 'After the response, the animation settles to a static brain icon and “Reasoning.” Your open or closed choice stays the same.',
  stopped: 'Partial thinking is retained. No success checkmark; the existing error or retry UI would remain alongside the message.',
  unavailable: 'No invented reasoning. The panel explains that this model has not shared thinking text.'
};
function setState(next, reset = false) {
  clearInterval(streamTimer);
  clearInterval(wordTimer);
  state = next;
  shell.dataset.state = state;
  if (reset) row.setAttribute('aria-expanded', 'false');
  following = true;
  readingPosition = 0;
  $('thinking-follow').hidden = true;
  $('mock-answer').hidden = state !== 'done';
  $('mock-note').textContent = notes[state];
  if (state === 'live') {
    offset = 110;
    content.textContent = fullText.slice(0, offset);
    startWords();
    streamTimer = setInterval(stream, 550);
  } else if (state === 'waiting') {
    startWords();
    content.textContent = 'Waiting for the model to share thinking. It will appear here as it arrives.';
  } else if (state === 'done') {
    label('Reasoning', 'brain');
    content.textContent = fullText;
  } else if (state === 'stopped') {
    label('Interrupted', 'square');
    content.textContent = samples.slice(0, 2).join('\n\n');
  } else {
    label('Thinking', 'infinity');
    content.textContent = 'This model hasn’t shared thinking text. Its response will appear in the conversation.';
  }
  syncDisclosure();
}
$('mock-state').addEventListener('change', e => setState(e.target.value));
$('mock-replay').addEventListener('click', () => { $('mock-state').value = 'live'; setState('live', true); });
$('mock-theme').addEventListener('click', e => {
  const light = document.body.classList.toggle('theme-light');
  document.body.classList.toggle('theme-dark', !light);
  e.currentTarget.setAttribute('aria-pressed', String(light));
  e.currentTarget.textContent = light ? 'Dark theme' : 'Light theme';
});
$('mock-phone').addEventListener('click', e => {
  const mobile = document.body.classList.toggle('is-mobile');
  e.currentTarget.setAttribute('aria-pressed', String(mobile));
  e.currentTarget.textContent = mobile ? 'Desktop width' : 'Phone width';
});
setState('live', true);
