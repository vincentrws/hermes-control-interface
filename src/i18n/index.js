// Hermes Control Interface — Lightweight i18n
// No external deps, vanilla ES module.

let _locale = 'en';
let _dict = {};

const SUPPORTED = ['en', 'ja'];
const DEFAULT_LOCALE = 'en';

function detectLocale() {
  try {
    const saved = localStorage.getItem('hci.locale');
    if (saved && SUPPORTED.includes(saved)) return saved;
  } catch (e) {}
  const nav = (navigator.language || '').toLowerCase();
  if (nav.startsWith('ja')) return 'ja';
  return DEFAULT_LOCALE;
}

export async function initI18n() {
  _locale = detectLocale();
  await loadLocale(_locale);
  applyTranslations();
  document.documentElement.lang = _locale;
}

const I18N_VERSION = '3.6.0';

async function loadLocale(loc) {
  const url = '/i18n/' + loc + '.json?v=' + I18N_VERSION;
  try {
    const res = await fetch(url, { cache: 'no-cache' });
    if (!res.ok) throw new Error('locale fetch failed');
    _dict = await res.json();
  } catch (e) {
    console.warn('i18n: fallback to en', e);
    if (loc !== 'en') {
      _locale = 'en';
      const res = await fetch('/i18n/en.json?v=' + I18N_VERSION, { cache: 'no-cache' });
      _dict = await res.json();
    } else {
      _dict = {};
    }
  }
}

export function t(key, params) {
  const parts = key.split('.');
  let cur = _dict;
  for (const p of parts) {
    if (cur && typeof cur === 'object' && p in cur) cur = cur[p];
    else return key;
  }
  if (typeof cur !== 'string') return key;
  if (params) {
    return cur.replace(/\{(\w+)\}/g, (m, k) => (k in params ? params[k] : m));
  }
  return cur;
}

export function setLocale(loc) {
  if (!SUPPORTED.includes(loc)) return;
  try { localStorage.setItem('hci.locale', loc); } catch (e) {}
  location.reload();
}

export function getLocale() { return _locale; }

export function applyTranslations(root) {
  root = root || document;
  // Write only when the value actually changes. Writing textContent is itself a
  // DOM mutation, and a MutationObserver in main.js re-invokes this on every
  // mutation — so unconditional writes create a perpetual re-translate loop that
  // (among other things) rebuilds open <select> dropdowns mid-interaction.
  root.querySelectorAll('[data-i18n]').forEach(el => {
    const val = t(el.getAttribute('data-i18n'));
    if (el.textContent !== val) el.textContent = val;
  });
  root.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
    const val = t(el.getAttribute('data-i18n-placeholder'));
    if (el.getAttribute('placeholder') !== val) el.setAttribute('placeholder', val);
  });
  root.querySelectorAll('[data-i18n-title]').forEach(el => {
    const val = t(el.getAttribute('data-i18n-title'));
    if (el.getAttribute('title') !== val) el.setAttribute('title', val);
  });
  root.querySelectorAll('[data-i18n-aria]').forEach(el => {
    const val = t(el.getAttribute('data-i18n-aria'));
    if (el.getAttribute('aria-label') !== val) el.setAttribute('aria-label', val);
  });
}

if (typeof window !== 'undefined') {
  window.__i18n = { t, setLocale, getLocale, applyTranslations };
}
