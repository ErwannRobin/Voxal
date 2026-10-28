// i18n.js — UI translation. A plain classic script shared by index.html and
// settings.html (no module system, no bundler). Declares ONE global, `I18N`,
// plus the lookup function `tr()`.
//
// English is the source language and lives in the markup / call sites
// themselves, so nothing here is needed to render it and a failed locale fetch
// leaves a working English UI:
//   • markup:  data-i18n="key"                 element text (or, if it has child
//                                              elements, its first text node)
//              data-i18n-html="key"            innerHTML (our own strings only)
//              data-i18n-title|placeholder|aria-label|alt="key"   attributes
//   • script:  tr('key', 'English default {name}', { name })
//              tr('key', { one: '{n} peer', other: '{n} peers' }, { n })
// `src/locales/en.json` is the translators' source of truth and is kept equal to
// the defaults by `make i18n-check`; the other files are `<code>.json`.
//
// The language is `localStorage['language']` (absent = follow the device). A
// change in any window reaches the others through the `storage` event.
var I18N = (function() {
  var STORAGE_KEY = 'language';
  var LANGS = [
    { code: 'en', native: 'English' },
    { code: 'fr', native: 'Français' },
    { code: 'es', native: 'Español' },
    { code: 'de', native: 'Deutsch' },
    { code: 'pt', native: 'Português' },
    { code: 'ro', native: 'Română' },
    { code: 'ru', native: 'Русский' },
    { code: 'uk', native: 'Українська' },
    { code: 'id', native: 'Bahasa Indonesia' },
    { code: 'zh', native: '简体中文' },
    { code: 'ja', native: '日本語' },
    { code: 'ar', native: 'العربية', rtl: true },
  ];
  var current = 'en';
  var dict = {};          // strings of `current` ({} for English)
  var cache = {};         // code -> dict, so switching back is instant
  var listeners = [];
  var ready = null;

  function known(code) {
    for (var i = 0; i < LANGS.length; i++) if (LANGS[i].code === code) return LANGS[i];
    return null;
  }

  // The stored choice, or '' for "follow the device".
  function stored() {
    try { var v = localStorage.getItem(STORAGE_KEY); return known(v) ? v : ''; } catch (_) { return ''; }
  }

  // Which of ours the device prefers: first match of navigator.languages by
  // base subtag (zh-TW still reads as Chinese, pt-BR as Portuguese).
  function detect() {
    var prefs = (navigator.languages && navigator.languages.length) ? navigator.languages : [navigator.language || 'en'];
    for (var i = 0; i < prefs.length; i++) {
      var base = String(prefs[i] || '').toLowerCase().split('-')[0];
      if (base === 'ua') base = 'uk';
      if (known(base)) return base;
    }
    return 'en';
  }

  function resolve() { return stored() || detect(); }

  function interpolate(s, vars) {
    if (!vars) return s;
    return s.replace(/\{(\w+)\}/g, function(m, k) { return vars[k] == null ? m : String(vars[k]); });
  }

  // A value is a string, or {one, other, ...} chosen by Intl.PluralRules on vars.n.
  function pick(v, vars) {
    if (v && typeof v === 'object') {
      var n = vars && vars.n;
      var cat = 'other';
      try { cat = new Intl.PluralRules(current).select(Number(n)); } catch (_) {}
      return v[cat] != null ? v[cat] : v.other;
    }
    return v;
  }

  function tr(key, def, vars) {
    var v = Object.prototype.hasOwnProperty.call(dict, key) ? dict[key] : undefined;
    return interpolate(String(pick(v != null ? v : def, vars)), vars);
  }

  // --- DOM -----------------------------------------------------------------

  // Replace an element's text. With child elements (an icon, a <strong>) only
  // its first non-blank text node changes, keeping the surrounding spacing.
  function setText(el, text) {
    if (!el.firstElementChild) { el.textContent = text; return; }
    for (var n = el.firstChild; n; n = n.nextSibling) {
      if (n.nodeType === 3 && n.nodeValue.trim()) {
        var m = /^(\s*)[\s\S]*?(\s*)$/.exec(n.nodeValue);
        n.nodeValue = m[1] + text + m[2];
        return;
      }
    }
  }
  function getText(el) {
    if (!el.firstElementChild) return el.textContent;
    for (var n = el.firstChild; n; n = n.nextSibling) {
      if (n.nodeType === 3 && n.nodeValue.trim()) return n.nodeValue.replace(/\s+/g, ' ').trim();
    }
    return '';
  }

  var ATTRS = ['title', 'placeholder', 'aria-label', 'alt'];

  // Each element remembers its English original the first time it is touched,
  // and what we last wrote; if the page has since put something else there
  // (a live status line that started life as a tagged placeholder) we leave it.
  function applyEl(el, key, kind) {
    var o = el._i18n || (el._i18n = {});
    var slot = o[kind] || (o[kind] = { orig: null, wrote: null });
    var now = kind === 'text' ? getText(el) : kind === 'html' ? el.innerHTML : el.getAttribute(kind);
    if (slot.orig === null) slot.orig = now;
    else if (slot.wrote !== null && now !== slot.wrote) return;
    var want = Object.prototype.hasOwnProperty.call(dict, key) ? dict[key] : slot.orig;
    if (kind === 'text') setText(el, want);
    else if (kind === 'html') el.innerHTML = want;
    else el.setAttribute(kind, want);
    slot.wrote = kind === 'text' ? getText(el) : kind === 'html' ? el.innerHTML : el.getAttribute(kind);
  }

  function apply(root) {
    root = root || document;
    var list = root.querySelectorAll('[data-i18n]');
    for (var i = 0; i < list.length; i++) applyEl(list[i], list[i].getAttribute('data-i18n'), 'text');
    list = root.querySelectorAll('[data-i18n-html]');
    for (i = 0; i < list.length; i++) applyEl(list[i], list[i].getAttribute('data-i18n-html'), 'html');
    ATTRS.forEach(function(a) {
      var l = root.querySelectorAll('[data-i18n-' + a + ']');
      for (var j = 0; j < l.length; j++) applyEl(l[j], l[j].getAttribute('data-i18n-' + a), a);
    });
  }

  function paintDocument() {
    var meta = known(current) || LANGS[0];
    var de = document.documentElement;
    de.setAttribute('lang', current);
    // Layout stays left-to-right (the room geometry is measured in physical
    // pixels); a right-to-left language gets right-to-left TEXT via
    // `html[data-text-dir]` in styles.css instead of a mirrored page.
    de.setAttribute('data-text-dir', meta.rtl ? 'rtl' : 'ltr');
    apply(document);
    var sel = document.getElementById('select-language');
    if (sel) sel.value = stored();
  }

  function load(code) {
    if (code === 'en') return Promise.resolve({});
    if (cache[code]) return Promise.resolve(cache[code]);
    return fetch('locales/' + code + '.json').then(function(r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    }).then(function(d) { return (cache[code] = d); });
  }

  // Switch to `code` ('' = follow the device) and repaint.
  function setLanguage(code, opts) {
    if (code && !known(code)) return Promise.resolve(current);
    if (!(opts && opts.fromStorage)) {
      try { if (code) localStorage.setItem(STORAGE_KEY, code); else localStorage.removeItem(STORAGE_KEY); } catch (_) {}
    }
    var want = code || detect();
    return load(want).then(function(d) {
      dict = d; current = want;
      if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', paintDocument, { once: true });
      else paintDocument();
      listeners.slice().forEach(function(fn) { try { fn(current); } catch (_) {} });
      return current;
    }, function(err) {
      // A missing file leaves the UI as it is — English, or the last language.
      if (typeof console !== 'undefined') console.warn('[i18n] could not load', want, err && err.message);
      return current;
    });
  }

  function fillPicker(sel) {
    if (!sel || sel.options.length) return;
    var auto = document.createElement('option');
    auto.value = '';
    auto.setAttribute('data-i18n', 'ui.language_auto');
    auto.textContent = 'Automatic (device language)';
    sel.appendChild(auto);
    LANGS.forEach(function(l) {
      var o = document.createElement('option');
      o.value = l.code; o.textContent = l.native; o.lang = l.code;
      sel.appendChild(o);
    });
    sel.value = stored();
    sel.addEventListener('change', function() { setLanguage(sel.value); });
  }

  function onChange(fn) { listeners.push(fn); }

  window.addEventListener('storage', function(e) {
    if (e.key === STORAGE_KEY) setLanguage(stored(), { fromStorage: true });
  });

  function init() {
    var sel = document.getElementById('select-language');
    fillPicker(sel);
    ready = setLanguage(stored(), { fromStorage: true });
  }
  // The language is applied to markup parsed so far, so run as soon as the
  // document body exists; main.js's own DOMContentLoaded work then paints on top.
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

  return {
    LANGS: LANGS,
    STORAGE_KEY: STORAGE_KEY,
    get lang() { return current; },
    get ready() { return ready || Promise.resolve(current); },
    setLanguage: setLanguage,
    apply: apply,
    onChange: onChange,
    resolve: resolve,
    tr: tr,
  };
})();

function tr(key, def, vars) { return I18N.tr(key, def, vars); }
