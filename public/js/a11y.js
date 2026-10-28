/* Display + accessibility preferences, remembered in localStorage and applied to <html> as data attributes:
     theme      light | dark                 saved choice, else the operating system        (data-theme)
     palette    maroon | ocean | forest | graphite  accent colours                          (data-palette)
     text size  80%..200%                                                                    (--text-scale)
     contrast   normal | high                saved choice, else the OS "more contrast"      (data-contrast)
     motion     full | reduce                saved choice, else the OS "reduce motion"      (data-motion)
     focus      normal | strong              thicker keyboard focus outline                 (data-focus)
     shortcuts  on | off                     optional single-key shortcuts (read by settings.js)
   Loaded as a tiny BLOCKING script in <head> on purpose: the saved choices are applied before first paint (no flash).
   Pages that have the full Settings page (#settingsRoot) get their controls there; every other page keeps a small toolbar. */
(function () {
  'use strict';

  const THEME_KEY = 'am.theme';        // 'light' | 'dark'; absent = follow the operating system
  const SCALE_KEY = 'am.textScale';    // whole percent, MIN..MAX in STEP increments
  const PALETTE_KEY = 'am.palette';    // one of PALETTES; absent = maroon
  const CONTRAST_KEY = 'am.contrast';  // 'on' | 'off'; absent = follow the operating system
  const MOTION_KEY = 'am.motion';      // 'reduce' | 'full'; absent = follow the operating system
  const FOCUS_KEY = 'am.focus';        // 'strong'; absent = normal
  const SHORTCUTS_KEY = 'am.shortcuts'; // 'on'; absent = off
  const ALL_KEYS = [THEME_KEY, SCALE_KEY, PALETTE_KEY, CONTRAST_KEY, MOTION_KEY, FOCUS_KEY, SHORTCUTS_KEY];

  const PALETTES = ['maroon', 'ocean', 'forest', 'graphite'];
  const DEFAULT_PALETTE = 'maroon';
  const MIN = 80;
  const MAX = 200;
  const STEP = 10;
  const DEFAULT = 100;

  const root = document.documentElement;

  // localStorage throws in some private modes / when blocked: every access goes through here.
  const store = {
    get(key) { try { return window.localStorage.getItem(key); } catch { return null; } },
    set(key, value) { try { window.localStorage.setItem(key, value); } catch { /* not persisted */ } },
    remove(key) { try { window.localStorage.removeItem(key); } catch { /* ignore */ } }
  };

  const media = (query) => (window.matchMedia ? window.matchMedia(query) : null);
  const systemQuery = media('(prefers-color-scheme: dark)');
  const contrastQuery = media('(prefers-contrast: more)');
  const motionQuery = media('(prefers-reduced-motion: reduce)');

  // ---- resolved values -------------------------------------------------------------------------------------------
  const systemTheme = () => (systemQuery && systemQuery.matches ? 'dark' : 'light');
  const savedTheme = () => { const t = store.get(THEME_KEY); return t === 'light' || t === 'dark' ? t : null; };
  const theme = () => savedTheme() || systemTheme();

  const clampScale = (n) => Math.min(MAX, Math.max(MIN, Math.round(n / STEP) * STEP));
  const scale = () => {
    const n = parseInt(store.get(SCALE_KEY), 10);
    return Number.isFinite(n) ? clampScale(n) : DEFAULT;
  };

  const palette = () => { const p = store.get(PALETTE_KEY); return PALETTES.includes(p) ? p : DEFAULT_PALETTE; };

  const savedContrast = () => { const v = store.get(CONTRAST_KEY); return v === 'on' || v === 'off' ? v : null; };
  const contrast = () => { const saved = savedContrast(); return saved ? saved === 'on' : Boolean(contrastQuery && contrastQuery.matches); };

  const savedMotion = () => { const v = store.get(MOTION_KEY); return v === 'reduce' || v === 'full' ? v : null; };
  const motion = () => savedMotion() || (motionQuery && motionQuery.matches ? 'reduce' : 'full');

  const focusRing = () => store.get(FOCUS_KEY) === 'strong';
  const shortcuts = () => store.get(SHORTCUTS_KEY) === 'on';

  // "Does this setting still follow the device?" (true until the person chooses for themselves)
  const followsSystem = (name) => ({ theme: !savedTheme(), contrast: !savedContrast(), motion: !savedMotion() })[name] === true;

  const snapshot = () => ({ theme: theme(), palette: palette(), scale: scale(), contrast: contrast(), motion: motion(), focusRing: focusRing(), shortcuts: shortcuts() });
  const announce = (name, detail) => document.dispatchEvent(new window.CustomEvent(name, { detail }));
  const changed = () => announce('am:a11ychange', snapshot()); // one event for "anything here changed" (the Settings page listens)

  // ---- applying --------------------------------------------------------------------------------------------------
  function applyTheme() {
    root.setAttribute('data-theme', theme()); // always explicit, so the stylesheet has a single dark palette
    announce('am:themechange', { theme: theme(), saved: Boolean(savedTheme()) });
    changed();
    syncUi();
  }

  // Palette and contrast change colours the same way a theme switch does, so charts rebuild on the same event.
  function applyAppearance() {
    root.setAttribute('data-palette', palette());
    root.setAttribute('data-contrast', contrast() ? 'high' : 'normal');
    announce('am:themechange', { theme: theme(), saved: Boolean(savedTheme()) });
    changed();
    syncUi();
  }

  function applyScale() {
    root.style.setProperty('--text-scale', String(scale() / 100));
    announce('am:scalechange', { percent: scale() });
    changed();
    syncUi();
  }

  function applyBehaviour() {
    root.setAttribute('data-motion', motion());
    root.setAttribute('data-focus', focusRing() ? 'strong' : 'normal');
    changed();
    syncUi();
  }

  // ---- setters ---------------------------------------------------------------------------------------------------
  function setTheme(next) {
    if (next === 'light' || next === 'dark') store.set(THEME_KEY, next); else store.remove(THEME_KEY);
    applyTheme();
  }
  const toggleTheme = () => setTheme(theme() === 'dark' ? 'light' : 'dark');

  function setScale(percent) {
    const next = clampScale(percent);
    if (next === DEFAULT) store.remove(SCALE_KEY); else store.set(SCALE_KEY, String(next));
    applyScale();
  }
  const stepScale = (direction) => setScale(scale() + direction * STEP);

  function setPalette(name) {
    if (PALETTES.includes(name) && name !== DEFAULT_PALETTE) store.set(PALETTE_KEY, name); else store.remove(PALETTE_KEY);
    applyAppearance();
  }

  // true / false = the person's choice, anything else = follow the device again
  function setContrast(value) {
    if (value === true || value === false) store.set(CONTRAST_KEY, value ? 'on' : 'off'); else store.remove(CONTRAST_KEY);
    applyAppearance();
  }

  function setMotion(value) {
    if (value === 'reduce' || value === 'full') store.set(MOTION_KEY, value); else store.remove(MOTION_KEY);
    applyBehaviour();
  }

  function setFocusRing(on) {
    if (on) store.set(FOCUS_KEY, 'strong'); else store.remove(FOCUS_KEY);
    applyBehaviour();
  }

  function setShortcuts(on) {
    if (on) store.set(SHORTCUTS_KEY, 'on'); else store.remove(SHORTCUTS_KEY);
    changed();
  }

  function reset() {
    ALL_KEYS.forEach((key) => store.remove(key));
    applyTheme();
    applyAppearance();
    applyScale();
    applyBehaviour();
  }

  // ---- toolbar (pages without the Settings page) -------------------------------------------------------------------
  const ui = {};

  function button(label, className, onClick, ariaLabel) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `btn btn-secondary btn-small ${className || ''}`.trim();
    b.textContent = label;
    if (ariaLabel) b.setAttribute('aria-label', ariaLabel);
    b.addEventListener('click', onClick);
    return b;
  }

  function syncUi() {
    if (!ui.bar) return;
    ui.theme.setAttribute('aria-pressed', String(theme() === 'dark'));
    ui.contrast.setAttribute('aria-pressed', String(contrast()));
    ui.value.textContent = `${scale()}%`;
    ui.smaller.setAttribute('aria-disabled', String(scale() <= MIN));
    ui.larger.setAttribute('aria-disabled', String(scale() >= MAX));
  }

  function buildUi() {
    if (ui.bar || !document.body) return;
    // The Settings page has every one of these controls (and more): no second, smaller copy next to it.
    if (document.getElementById('settingsRoot')) return;
    const bar = document.createElement('div');
    bar.className = 'a11y-bar no-print';
    bar.setAttribute('role', 'group');
    bar.setAttribute('aria-label', 'Display settings');

    ui.theme = button('Dark mode', '', toggleTheme);
    ui.smaller = button('A−', '', () => { if (scale() > MIN) stepScale(-1); }, 'Decrease text size');
    ui.value = document.createElement('output');
    ui.value.className = 'a11y-value';
    ui.value.setAttribute('aria-live', 'polite');
    ui.value.setAttribute('aria-label', 'Text size');
    ui.larger = button('A+', '', () => { if (scale() < MAX) stepScale(1); }, 'Increase text size');
    ui.contrast = button('High contrast', '', () => setContrast(!contrast()));
    const resetBtn = button('Reset', '', reset, 'Reset display settings');

    bar.append(ui.theme, ui.smaller, ui.value, ui.larger, ui.contrast, resetBtn);
    ui.bar = bar;
    const mount = document.getElementById('displaySettings');
    const skip = document.querySelector('.skip-link');
    if (mount) mount.append(bar); else if (skip) skip.after(bar); else document.body.prepend(bar);
    syncUi();
  }

  // Apply immediately (head), build the toolbar once the body exists.
  applyTheme();
  applyAppearance();
  applyScale();
  applyBehaviour();
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', buildUi); else buildUi();

  // Follow the OS only while the person has not chosen for themselves. (Contrast and motion are registered before the
  // theme listener on purpose: tests that fake matchMedia keep only the most recently registered callback.)
  if (contrastQuery && contrastQuery.addEventListener) contrastQuery.addEventListener('change', () => { if (!savedContrast()) applyAppearance(); });
  if (motionQuery && motionQuery.addEventListener) motionQuery.addEventListener('change', () => { if (!savedMotion()) applyBehaviour(); });
  if (systemQuery && systemQuery.addEventListener) {
    systemQuery.addEventListener('change', () => { if (!savedTheme()) applyTheme(); });
  }
  // Another tab changed a preference.
  window.addEventListener('storage', (event) => {
    const all = event.key === null;
    if (all || event.key === THEME_KEY) applyTheme();
    if (all || event.key === PALETTE_KEY || event.key === CONTRAST_KEY) applyAppearance();
    if (all || event.key === SCALE_KEY) applyScale();
    if (all || event.key === MOTION_KEY || event.key === FOCUS_KEY) applyBehaviour();
    if (event.key === SHORTCUTS_KEY) changed();
  });

  window.AMA11y = {
    setTheme, toggleTheme, setScale, stepScale, reset, theme, scale, MIN, MAX, STEP,
    palettes: PALETTES.slice(), palette, setPalette,
    contrast, setContrast, motion, setMotion, focusRing, setFocusRing, shortcuts, setShortcuts,
    followsSystem, state: snapshot, KEYS: ALL_KEYS.slice(),
    // Re-read every saved choice (after an import or a reset made behind this script's back).
    refresh() { applyTheme(); applyAppearance(); applyScale(); applyBehaviour(); }
  };
})();
