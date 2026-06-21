/*
 * app.js — Frontend logic for the typeahead UI.
 * =============================================
 * Concepts demonstrated here:
 *   - DEBOUNCING the input so we don't fire a request on every keystroke
 *   - Keyboard navigation (Up/Down/Enter/Escape) of the suggestion list
 *   - Loading + error states
 *   - Submitting a search (POST /search) and refreshing trending
 */

const $ = (sel) => document.querySelector(sel);
const input = $('#search');
const goBtn = $('#go');
const list = $('#suggestions');
const statusEl = $('#status');
const trendingList = $('#trending-list');
const metaEl = $('#meta');

let suggestions = [];   // current suggestion objects
let activeIndex = -1;   // which suggestion is highlighted (keyboard nav)
let trendingMode = 'enhanced';

/* ---------------------------------------------------------------------------
 * DEBOUNCING
 * ----------
 * A fast typist fires ~10 keystrokes/second. Calling /suggest on each one is
 * wasteful and can render out-of-order responses. Debouncing waits until the
 * user PAUSES (here 120ms) before sending one request. ANALOGY: an elevator
 * waits a moment for stragglers instead of leaving on every button press.
 * ------------------------------------------------------------------------- */
function debounce(fn, ms) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

async function fetchSuggestions(q) {
  if (!q.trim()) { renderSuggestions([], ''); return; }
  setStatus('Loading…');
  try {
    const res = await fetch(`/suggest?q=${encodeURIComponent(q)}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    renderSuggestions(data.suggestions, q);
    setStatus(`Served from ${data.source}${data.node ? ' · ' + data.node : ''}`);
  } catch (err) {
    setStatus(`Error: ${err.message}`, 'err');
    renderSuggestions([], q);
  }
}
const debouncedFetch = debounce(fetchSuggestions, 120);

function setStatus(msg, cls = '') {
  statusEl.textContent = msg;
  statusEl.className = 'status ' + cls;
}

/* Bold the matched prefix inside each suggestion for readability. */
function highlight(text, prefix) {
  const i = text.toLowerCase().indexOf(prefix.toLowerCase());
  if (i !== 0) return text;
  return `<b>${text.slice(0, prefix.length)}</b>${text.slice(prefix.length)}`;
}

function renderSuggestions(items, prefix) {
  suggestions = items || [];
  activeIndex = -1;
  if (!suggestions.length) {
    list.hidden = true;
    input.setAttribute('aria-expanded', 'false');
    return;
  }
  list.innerHTML = suggestions.map((s, i) => `
    <li role="option" data-i="${i}" id="opt-${i}">
      <span class="q">${highlight(s.query, prefix)}</span>
      <span class="count">${s.count.toLocaleString()}</span>
    </li>`).join('');
  list.hidden = false;
  input.setAttribute('aria-expanded', 'true');

  // Mouse selection
  [...list.children].forEach((li) => {
    li.addEventListener('mousedown', (e) => {
      e.preventDefault(); // keep focus in the input
      submitSearch(suggestions[+li.dataset.i].query);
    });
  });
}

function setActive(i) {
  const items = [...list.children];
  items.forEach((li) => li.classList.remove('active'));
  if (i >= 0 && i < items.length) {
    items[i].classList.add('active');
    input.setAttribute('aria-activedescendant', `opt-${i}`);
  }
  activeIndex = i;
}

/* ---------------------------------------------------------------------------
 * KEYBOARD NAVIGATION
 * ------------------- */
input.addEventListener('keydown', (e) => {
  if (list.hidden && e.key !== 'Enter') return;
  switch (e.key) {
    case 'ArrowDown':
      e.preventDefault();
      setActive(Math.min(activeIndex + 1, suggestions.length - 1));
      break;
    case 'ArrowUp':
      e.preventDefault();
      setActive(Math.max(activeIndex - 1, 0));
      break;
    case 'Enter':
      // If a suggestion is highlighted, search that; else search the raw input.
      submitSearch(activeIndex >= 0 ? suggestions[activeIndex].query : input.value);
      break;
    case 'Escape':
      list.hidden = true;
      input.setAttribute('aria-expanded', 'false');
      break;
  }
});

input.addEventListener('input', (e) => debouncedFetch(e.target.value));
goBtn.addEventListener('click', () => submitSearch(input.value));

/* ---------------------------------------------------------------------------
 * SUBMIT A SEARCH  (POST /search)
 * ------------------------------- */
async function submitSearch(query) {
  query = (query || '').trim();
  if (!query) return;
  input.value = query;
  list.hidden = true;
  input.setAttribute('aria-expanded', 'false');
  setStatus('Searching…');
  try {
    const res = await fetch('/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ q: query }),
    });
    const data = await res.json();
    setStatus(`${data.message}: "${query}"`);
    // Trending updates after the buffer flushes; refresh shortly after.
    setTimeout(loadTrending, 400);
  } catch (err) {
    setStatus(`Error: ${err.message}`, 'err');
  }
}

/* ---------------------------------------------------------------------------
 * TRENDING
 * -------- */
async function loadTrending() {
  try {
    const res = await fetch(`/trending?mode=${trendingMode}`);
    const data = await res.json();
    trendingList.innerHTML = (data.trending || []).map((t) => `
      <li data-q="${encodeURIComponent(t.query)}">
        <span class="label">${t.query}</span>
        <span class="score">${trendingMode === 'enhanced' ? 'score ' + t.score : t.total.toLocaleString() + ' searches'}</span>
      </li>`).join('') || '<li class="empty">No trending data yet. Try a search.</li>';
    [...trendingList.children].forEach((li) => {
      if (!li.dataset.q) return;
      li.addEventListener('click', () => {
        input.value = decodeURIComponent(li.dataset.q);
        fetchSuggestions(input.value);
        input.focus();
      });
    });
  } catch { /* trending is non-critical; ignore errors */ }
}

document.querySelectorAll('.segmented button').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.segmented button').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    trendingMode = btn.dataset.mode;
    loadTrending();
  });
});

// Hide dropdown when clicking away.
document.addEventListener('click', (e) => {
  if (!e.target.closest('.search-box')) {
    list.hidden = true;
    input.setAttribute('aria-expanded', 'false');
  }
});

// Initial load.
loadTrending();
fetch('/metrics').then((r) => r.json()).then((m) => {
  metaEl.textContent = `${m.dataset.uniqueQueries.toLocaleString()} queries · ${m.config.cacheNodes} cache nodes`;
}).catch(() => {});
