/* Settings page (the third tab on the educator dashboard and on the student page).

   Builds three sections into <div id="settingsRoot" data-role="educator|student">:
     Appearance     light / dark / device, accent colour
     Accessibility  text size, high contrast, reduced motion, keyboard navigation
     General        notifications, application preferences, data management
   Display and accessibility choices are owned by js/a11y.js (applied before first paint). Everything else is stored by
   AM.prefs, or under the keys the class list already used. All of it stays in this browser; nothing is sent to the server.
   Server-backed settings (server address, privacy and consent, account deletion) are plain markup in the page itself.

   Plain script, no dependencies. Text is only ever inserted with textContent. */
(function () {
  'use strict';

  const root = document.getElementById('settingsRoot');
  const A11y = window.AMA11y;
  const AM = window.AM;
  if (!root || !A11y || !AM) return;

  const role = root.dataset.role === 'student' ? 'student' : 'educator';
  const { prefs, toast, confirmDialog, session } = AM;

  // ---- small helpers ------------------------------------------------------------------------------------------------
  const el = (tag, props = {}, text) => {
    const node = document.createElement(tag);
    Object.assign(node, props);
    if (text !== undefined) node.textContent = text;
    return node;
  };
  let counter = 0;
  const uid = (prefix) => `${prefix}-${(counter += 1)}`;
  const syncers = [];
  const syncAll = () => syncers.forEach((fn) => fn());

  const lsGet = (key) => { try { return window.localStorage.getItem(key); } catch { return null; } };
  const lsSet = (key, value) => { try { window.localStorage.setItem(key, value); } catch { /* not remembered */ } };
  const lsRemove = (key) => { try { window.localStorage.removeItem(key); } catch { /* ignore */ } };

  // One polite status line for actions (export, import, reset…). Toggles are announced by the controls themselves.
  const status = el('p', { id: 'settingsStatus', className: 'visually-hidden' });
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  function notify(message, isError = false) {
    status.textContent = '';
    window.setTimeout(() => { status.textContent = message; }, 30); // a changed text is what screen readers announce
    toast(message, isError);
  }

  // ---- building blocks ----------------------------------------------------------------------------------------------
  function section(id, title, intro) {
    const wrap = el('section', { className: 'card settings-section', id });
    const heading = el('h2', { id: `${id}-title`, tabIndex: -1 }, title);
    wrap.setAttribute('aria-labelledby', heading.id);
    wrap.append(heading);
    if (intro) wrap.append(el('p', { className: 'muted small' }, intro));
    return wrap;
  }

  function group(title, intro) {
    const wrap = el('div', { className: 'settings-group' });
    wrap.setAttribute('role', 'group');
    const heading = el('h3', { id: uid('group') }, title);
    wrap.setAttribute('aria-labelledby', heading.id);
    wrap.append(heading);
    if (intro) wrap.append(el('p', { className: 'muted small' }, intro));
    return wrap;
  }

  // A row: title + description on the left, the control on the right.
  function row({ title, desc, control, labelFor, extra }) {
    const wrap = el('div', { className: 'setting-row' });
    const text = el('div', { className: 'setting-text' });
    const label = el(labelFor ? 'label' : 'p', { className: 'setting-title' }, title);
    if (labelFor) label.htmlFor = labelFor;
    text.append(label);
    if (desc) {
      const d = el('p', { className: 'setting-desc', id: uid('desc') }, desc);
      text.append(d);
      wrap.descId = d.id;
    }
    if (extra) text.append(extra);
    wrap.append(text);
    if (control) wrap.append(el('div', { className: 'setting-control' }, undefined));
    if (control) wrap.lastChild.append(...[].concat(control));
    return wrap;
  }

  // A toggle that is announced as a switch. `get` reads the state, `set` applies the person's choice.
  function switchRow({ title, desc, get, set, follow }) {
    const id = uid('switch');
    const input = el('input', { type: 'checkbox', id, className: 'switch' });
    input.setAttribute('role', 'switch');
    const track = el('span', { className: 'switch-track' });
    track.setAttribute('aria-hidden', 'true');
    const control = el('span', { className: 'switch-wrap' });
    control.append(input, track);

    let followNote = null;
    if (follow) {
      followNote = el('span', { className: 'setting-follow hint' });
      const useDevice = el('button', { type: 'button', className: 'btn btn-ghost btn-small' }, 'Use my device setting');
      useDevice.addEventListener('click', () => follow.useDevice());
      followNote.append(el('span', { className: 'follow-text' }), ' ', useDevice);
    }
    const wrap = row({ title, desc, control, labelFor: id, extra: followNote });
    if (wrap.descId) input.setAttribute('aria-describedby', wrap.descId);

    input.addEventListener('change', () => set(input.checked, input));
    const sync = () => {
      input.checked = Boolean(get());
      if (followNote) {
        const following = follow.isFollowing();
        followNote.querySelector('.follow-text').textContent = following ? 'Following your device setting.' : 'Set by you.';
        followNote.querySelector('button').hidden = following;
      }
    };
    syncers.push(sync);
    sync();
    return { wrap, input, sync };
  }

  // A set of radio buttons drawn as large choices. `options`: [{ value, label, hint?, swatch? }].
  function choiceGroup({ legend, desc, name, options, get, set, className = '' }) {
    const fieldset = el('fieldset', { className: `choice-group ${className}`.trim() });
    fieldset.append(el('legend', { className: 'setting-title' }, legend));
    if (desc) fieldset.append(el('p', { className: 'setting-desc' }, desc));
    const list = el('div', { className: 'choices' });
    const inputs = options.map((option) => {
      const label = el('label', { className: 'choice' });
      const input = el('input', { type: 'radio', name, value: option.value });
      const face = el('span', { className: 'choice-face' });
      if (option.swatch) { const dot = el('span', { className: `swatch swatch-${option.swatch}` }); dot.setAttribute('aria-hidden', 'true'); face.append(dot); }
      face.append(el('span', { className: 'choice-label' }, option.label));
      if (option.hint) face.append(el('span', { className: 'choice-hint' }, option.hint));
      label.append(input, face);
      input.addEventListener('change', () => { if (input.checked) set(option.value); });
      list.append(label);
      return input;
    });
    fieldset.append(list);
    const sync = () => { const current = get(); inputs.forEach((input) => { input.checked = input.value === current; }); };
    syncers.push(sync);
    sync();
    return fieldset;
  }

  function selectRow({ title, desc, options, get, set }) {
    const id = uid('select');
    const select = el('select', { id });
    options.forEach((o) => select.append(el('option', { value: o.value }, o.label)));
    const wrap = row({ title, desc, control: select, labelFor: id });
    if (wrap.descId) select.setAttribute('aria-describedby', wrap.descId);
    select.addEventListener('change', () => set(select.value));
    const sync = () => { const current = get(); if ([...select.options].some((o) => o.value === current)) select.value = current; };
    syncers.push(sync);
    sync();
    return wrap;
  }

  // ======================================================================================================================
  // Appearance
  // ======================================================================================================================
  function buildAppearance() {
    const box = section('settings-appearance', 'Appearance', 'How Attentix looks on this device. Changes apply straight away and are remembered here.');

    box.append(choiceGroup({
      legend: 'Mode', name: 'theme-mode',
      desc: 'Light, dark, or whatever your device is set to.',
      options: [
        { value: 'light', label: 'Light' },
        { value: 'dark', label: 'Dark' },
        { value: 'system', label: 'Match my device' }
      ],
      get: () => (A11y.followsSystem('theme') ? 'system' : A11y.theme()),
      set: (value) => A11y.setTheme(value === 'system' ? null : value)
    }));

    box.append(choiceGroup({
      legend: 'Colour theme', name: 'palette',
      desc: 'The accent colour used for the header, buttons and charts.',
      className: 'choice-group-swatches',
      options: [
        { value: 'maroon', label: 'Maroon', hint: 'Default', swatch: 'maroon' },
        { value: 'ocean', label: 'Ocean', swatch: 'ocean' },
        { value: 'forest', label: 'Forest', swatch: 'forest' },
        { value: 'graphite', label: 'Graphite', swatch: 'graphite' }
      ],
      get: () => A11y.palette(),
      set: (value) => A11y.setPalette(value)
    }));
    return box;
  }

  // ======================================================================================================================
  // Accessibility
  // ======================================================================================================================
  function buildTextSize() {
    const id = uid('range');
    const range = el('input', { type: 'range', id, min: String(A11y.MIN), max: String(A11y.MAX), step: String(A11y.STEP), className: 'range' });
    const value = el('output', { className: 'range-value' });
    value.setAttribute('for', id);
    const smaller = el('button', { type: 'button', className: 'btn btn-secondary btn-small' }, 'A−');
    smaller.setAttribute('aria-label', 'Decrease text size');
    const larger = el('button', { type: 'button', className: 'btn btn-secondary btn-small' }, 'A+');
    larger.setAttribute('aria-label', 'Increase text size');
    const reset = el('button', { type: 'button', className: 'btn btn-ghost btn-small' }, 'Reset');
    reset.setAttribute('aria-label', 'Reset text size to 100%');

    range.addEventListener('input', () => A11y.setScale(Number(range.value)));
    smaller.addEventListener('click', () => A11y.stepScale(-1));
    larger.addEventListener('click', () => A11y.stepScale(1));
    reset.addEventListener('click', () => A11y.setScale(100));

    const controls = el('div', { className: 'range-row' });
    controls.append(smaller, range, larger, value, reset);
    const wrap = row({ title: 'Text size', desc: 'Makes all text and spacing larger or smaller, from 80% to 200%.', control: controls, labelFor: id });
    wrap.classList.add('setting-row-wide');
    const preview = el('p', { className: 'setting-preview' }, 'Sample: signals, not proof. A quick check-in may help.');
    wrap.append(preview);

    const sync = () => {
      const percent = A11y.scale();
      range.value = String(percent);
      range.setAttribute('aria-valuetext', `${percent}%`);
      value.textContent = `${percent}%`;
      smaller.setAttribute('aria-disabled', String(percent <= A11y.MIN));
      larger.setAttribute('aria-disabled', String(percent >= A11y.MAX));
      reset.hidden = percent === 100;
    };
    syncers.push(sync);
    sync();
    return wrap;
  }

  function buildKeyboard() {
    const box = group('Keyboard navigation', 'Everything in Attentix can be used without a mouse.');

    box.append(switchRow({
      title: 'Stronger focus outline',
      desc: 'A thicker outline around the item you are on, so it is easier to follow with the Tab key.',
      get: () => A11y.focusRing(),
      set: (on) => A11y.setFocusRing(on)
    }).wrap);

    const shortcutDesc = role === 'educator'
      ? 'Press g then h, c or s to open Home, Classes or Settings, and / to jump to a search box. Off by default so it never clashes with a screen reader.'
      : 'Press g then h, c or s to open Home, My class or Settings. Off by default so it never clashes with a screen reader.';
    box.append(switchRow({
      title: 'Keyboard shortcuts',
      desc: shortcutDesc,
      get: () => A11y.shortcuts(),
      set: (on) => A11y.setShortcuts(on)
    }).wrap);

    const help = el('details', { className: 'key-help' });
    help.append(el('summary', {}, 'Keyboard guide'));
    const list = el('dl', { className: 'key-list' });
    const keys = [
      ['Tab and Shift+Tab', 'Move to the next or previous control. The first Tab on every page reveals “Skip to content”.'],
      ['← → Home End', 'Move between the Home, Classes and Settings tabs while one is selected.'],
      ['Enter or Space', 'Press the focused button, open a link or flip a switch.'],
      ['Esc', 'Close a dialog. Focus returns to where you were.'],
      ['↑ ↓', 'Change the value of a slider or a drop-down list.']
    ];
    keys.forEach(([key, what]) => { list.append(el('dt', {}, key), el('dd', {}, what)); });
    help.append(list);
    box.append(help);
    return box;
  }

  function buildAccessibility() {
    const box = section('settings-accessibility', 'Accessibility', 'Make Attentix easier to read, see and use. These apply on every page.');
    box.append(buildTextSize());

    box.append(switchRow({
      title: 'High contrast',
      desc: 'Stronger text and borders, underlined links and no soft shadows.',
      get: () => A11y.contrast(),
      set: (on) => A11y.setContrast(on),
      follow: { isFollowing: () => A11y.followsSystem('contrast'), useDevice: () => A11y.setContrast(null) }
    }).wrap);

    box.append(switchRow({
      title: 'Reduce motion',
      desc: 'Turns off sliding, fading and chart animation.',
      get: () => A11y.motion() === 'reduce',
      set: (on) => A11y.setMotion(on ? 'reduce' : 'full'),
      follow: { isFollowing: () => A11y.followsSystem('motion'), useDevice: () => A11y.setMotion(null) }
    }).wrap);

    box.append(buildKeyboard());
    return box;
  }

  // ======================================================================================================================
  // General: notifications
  // ======================================================================================================================
  const desktopSupported = () => Boolean(window.isSecureContext && 'Notification' in window);

  async function chooseDesktopAlerts(on) {
    if (!on) { prefs.set('alertsDesktop', false); return; }
    if (!desktopSupported()) { prefs.set('alertsDesktop', false); notify('Desktop notifications need a secure address (https, or localhost) and a browser that supports them.', true); return; }
    let permission = window.Notification.permission;
    if (permission === 'default') {
      try { permission = await window.Notification.requestPermission(); } catch { permission = 'denied'; }
    }
    if (permission === 'granted') { prefs.set('alertsDesktop', true); notify('Desktop notifications are on.'); return; }
    prefs.set('alertsDesktop', false);
    notify('Your browser is blocking notifications for this site. Allow them in the browser’s site settings, then try again.', true);
  }

  function buildNotifications() {
    const box = group('Notifications');
    box.append(switchRow({
      title: 'Confirmation messages',
      desc: 'Short messages such as “Class created” or “Copied”. Errors always show.',
      get: () => prefs.get('toasts', true) !== false,
      set: (on) => prefs.set('toasts', on)
    }).wrap);

    if (role === 'educator') {
      const alerts = switchRow({
        title: 'Check-in alerts',
        desc: 'Tell me when the average attentiveness of the class I have open drops below 60. Signals, not proof: it is a prompt to check in, never a verdict. No student names are shown.',
        get: () => prefs.get('alerts', false) === true,
        set: (on) => { prefs.set('alerts', on); if (!on) prefs.set('alertsDesktop', false); }
      });
      box.append(alerts.wrap);

      const desktop = switchRow({
        title: 'Desktop notifications',
        desc: desktopSupported()
          ? 'Also show an alert from your browser when this tab is in the background.'
          : 'Needs a secure address (https, or localhost) and a browser that supports notifications, so it is not available here.',
        get: () => prefs.get('alertsDesktop', false) === true && prefs.get('alerts', false) === true,
        set: (on) => chooseDesktopAlerts(on)
      });
      const gate = () => { desktop.input.disabled = !desktopSupported() || prefs.get('alerts', false) !== true; };
      syncers.push(gate);
      gate();
      box.append(desktop.wrap);
    }
    return box;
  }

  // ======================================================================================================================
  // General: application preferences
  // ======================================================================================================================
  const VIEW_KEY = 'am.classes.view';
  const SORT_KEY = 'am.classes.sort';

  function buildApplication() {
    const box = group('Application');
    box.append(selectRow({
      title: 'Open Attentix on',
      desc: 'The tab you see first when the address does not name one.',
      options: [{ value: 'home', label: 'Home' }, { value: 'classes', label: role === 'educator' ? 'Classes' : 'My class' }],
      get: () => prefs.get('start', 'home'),
      set: (value) => prefs.set('start', value === 'classes' ? 'classes' : 'home')
    }));

    if (role === 'educator') {
      box.append(choiceGroup({
        legend: 'Class layout', name: 'class-layout',
        desc: 'How the Classes tab lists your classes.',
        options: [{ value: 'grid', label: 'Cards' }, { value: 'list', label: 'List' }],
        get: () => (lsGet(VIEW_KEY) === 'list' ? 'list' : 'grid'),
        set: (value) => { lsSet(VIEW_KEY, value === 'list' ? 'list' : 'grid'); document.dispatchEvent(new window.CustomEvent('am:prefchange', { detail: { name: 'classView' } })); }
      }));

      // The sort options come from the Classes tab's own drop-down, so the two can never disagree.
      const classSort = document.getElementById('classSort');
      const sortOptions = classSort ? [...classSort.options].map((o) => ({ value: o.value, label: o.textContent })) : [];
      if (sortOptions.length) {
        box.append(selectRow({
          title: 'Sort classes by',
          desc: 'The order the Classes tab starts in.',
          options: sortOptions,
          get: () => lsGet(SORT_KEY) || sortOptions[0].value,
          set: (value) => { lsSet(SORT_KEY, value); document.dispatchEvent(new window.CustomEvent('am:prefchange', { detail: { name: 'classSort' } })); }
        }));
      }
    }
    return box;
  }

  // ======================================================================================================================
  // General: data management (this browser only)
  // ======================================================================================================================
  const SIMPLE_VALUES = {
    'am.theme': (v) => v === 'light' || v === 'dark',
    'am.textScale': (v) => /^\d{2,3}$/.test(v) && Number(v) >= A11y.MIN && Number(v) <= A11y.MAX,
    'am.palette': (v) => A11y.palettes.includes(v),
    'am.contrast': (v) => v === 'on' || v === 'off',
    'am.motion': (v) => v === 'reduce' || v === 'full',
    'am.focus': (v) => v === 'strong',
    'am.shortcuts': (v) => v === 'on',
    [VIEW_KEY]: (v) => v === 'grid' || v === 'list',
    [SORT_KEY]: (v) => /^[a-z-]{1,20}$/.test(v)
  };
  const PREF_VALUE = /^(true|false|"[a-z]{1,20}")$/; // AM.prefs stores JSON booleans and short words
  const isPrefKey = (key) => Object.prototype.hasOwnProperty.call(SIMPLE_VALUES, key) || /^am\.pref\.[A-Za-z]{1,30}$/.test(key);
  const isValidPref = (key, value) => typeof value === 'string' && (SIMPLE_VALUES[key] ? SIMPLE_VALUES[key](value) : PREF_VALUE.test(value));

  // Only these keys are ever exported, imported or reset: never the student sign-in, a cached class code or recents.
  function readPrefs() {
    const out = {};
    try {
      for (let i = 0; i < window.localStorage.length; i += 1) {
        const key = window.localStorage.key(i);
        if (key && isPrefKey(key)) out[key] = window.localStorage.getItem(key);
      }
    } catch { /* storage blocked */ }
    return out;
  }

  const applyEverywhere = () => {
    A11y.refresh();
    document.dispatchEvent(new window.CustomEvent('am:prefchange', { detail: { name: '*' } }));
    syncAll();
  };

  function exportPrefs() {
    const payload = { app: 'Attentix', kind: 'preferences', exportedAt: new Date().toISOString(), preferences: readPrefs() };
    const url = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }));
    const link = el('a', { href: url, download: 'attentix-preferences.json' });
    document.body.append(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 10000);
    notify('Preferences exported.');
  }

  function importPrefs(file) {
    if (!file) return;
    if (file.size > 20000) { notify('That file is too large to be an Attentix preferences export.', true); return; }
    const reader = new window.FileReader();
    reader.addEventListener('error', () => notify('Could not read that file.', true));
    reader.addEventListener('load', () => {
      let data;
      try { data = JSON.parse(String(reader.result)); } catch { data = null; }
      const incoming = data && data.app === 'Attentix' && data.preferences && typeof data.preferences === 'object' ? data.preferences : null;
      if (!incoming) { notify('That is not an Attentix preferences export.', true); return; }
      const accepted = Object.entries(incoming).filter(([key, value]) => isPrefKey(key) && isValidPref(key, value));
      if (!accepted.length) { notify('That file has no preferences this version understands.', true); return; }
      accepted.forEach(([key, value]) => lsSet(key, value));
      applyEverywhere();
      notify(`Imported ${accepted.length} ${accepted.length === 1 ? 'preference' : 'preferences'}.`);
    });
    reader.readAsText(file);
  }

  async function resetPrefs() {
    const ok = await confirmDialog({
      title: 'Reset all preferences?',
      message: 'Appearance, accessibility, notification and application settings go back to their defaults on this device. Your classes, account and sign-in are not touched.',
      confirmLabel: 'Reset preferences'
    });
    if (!ok) return;
    Object.keys(readPrefs()).forEach(lsRemove);
    applyEverywhere();
    notify('Preferences reset to their defaults.');
  }

  function clearRecents() {
    let removed = 0;
    try {
      const keys = [];
      for (let i = 0; i < window.localStorage.length; i += 1) keys.push(window.localStorage.key(i));
      keys.filter((k) => k && k.startsWith('am.recentClasses.')).forEach((k) => { lsRemove(k); removed += 1; });
    } catch { /* storage blocked */ }
    document.dispatchEvent(new window.CustomEvent('am:prefchange', { detail: { name: 'recents' } }));
    notify(removed ? 'Recently opened classes cleared.' : 'There were no recently opened classes to clear.');
  }

  function actionRow({ title, desc, label, onClick, danger = false, id }) {
    const button = el('button', { type: 'button', className: `btn ${danger ? 'btn-danger' : 'btn-secondary'} btn-small` }, label);
    if (id) button.id = id;
    button.addEventListener('click', onClick);
    return { wrap: row({ title, desc, control: button }), button };
  }

  function buildData() {
    const box = group('Data management', 'Preferences are kept in this browser only. Nothing here is sent to the server.');

    box.append(actionRow({ title: 'Export preferences', desc: 'Save your settings to a file, for example to use on another computer.', label: 'Export', onClick: exportPrefs }).wrap);

    const fileInput = el('input', { type: 'file', accept: 'application/json,.json', className: 'visually-hidden', id: uid('import') });
    fileInput.tabIndex = -1;
    fileInput.setAttribute('aria-hidden', 'true');
    fileInput.addEventListener('change', () => { importPrefs(fileInput.files && fileInput.files[0]); fileInput.value = ''; });
    const importRow = actionRow({ title: 'Import preferences', desc: 'Load a file you exported earlier. Only settings Attentix recognises are used.', label: 'Choose file…', onClick: () => fileInput.click() });
    importRow.wrap.append(fileInput);
    box.append(importRow.wrap);

    if (role === 'educator') {
      box.append(actionRow({ title: 'Recently opened classes', desc: 'Clears the shortcuts on Home. Your classes are not affected.', label: 'Clear', onClick: clearRecents }).wrap);
    } else {
      const forget = actionRow({
        title: 'Signed in on this device', desc: 'You chose to stay signed in here. Forget this device to ask for your details again next time.',
        label: 'Forget this device',
        onClick: () => { session.forgetDevice(); syncAll(); notify('This device will no longer stay signed in.'); }
      });
      const sync = () => { forget.wrap.hidden = !session.isRemembered(); };
      syncers.push(sync);
      sync();
      box.append(forget.wrap);
    }

    box.append(actionRow({ title: 'Reset all preferences', desc: 'Go back to the default look and behaviour on this device.', label: 'Reset…', onClick: resetPrefs, danger: true }).wrap);

    const note = el('p', { className: 'hint' });
    if (role === 'educator') {
      note.append('Class data lives on each class: open a class to export its roster as CSV or clear its live data. ');
      note.append(el('a', { href: '#classes', className: 'link' }, 'Go to Classes'));
      note.lastChild.setAttribute('data-goto', 'classes');
    } else {
      note.append('Withdrawing consent, leaving your class and deleting your data are under ');
      note.append(el('a', { href: '#privacyControls' }, 'Privacy & consent'));
      note.append('.');
    }
    box.append(note);
    return box;
  }

  function buildGeneral() {
    const box = section('settings-general', 'General');
    box.append(buildNotifications(), buildApplication(), buildData());
    return box;
  }

  // ======================================================================================================================
  // Keyboard shortcuts (opt-in)
  // ======================================================================================================================
  let awaitingSecondKey = false;
  let sequenceTimer = null;
  const typingTarget = (target) => Boolean(target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)));

  document.addEventListener('keydown', (event) => {
    if (!A11y.shortcuts() || event.ctrlKey || event.metaKey || event.altKey || event.defaultPrevented) return;
    if (typingTarget(event.target) || document.querySelector('dialog[open]')) return;
    const key = event.key.toLowerCase();

    if (awaitingSecondKey) {
      awaitingSecondKey = false;
      window.clearTimeout(sequenceTimer);
      const tab = { h: 'home', c: 'classes', s: 'settings' }[key];
      if (tab && window.AMNav && window.AMNav.show(tab)) {
        event.preventDefault();
        const selected = document.querySelector('[role="tab"][aria-selected="true"]');
        if (selected) selected.focus();
      }
      return;
    }
    if (key === 'g') {
      awaitingSecondKey = true;
      sequenceTimer = window.setTimeout(() => { awaitingSecondKey = false; }, 1500);
    } else if (key === '/' && role === 'educator') {
      const search = ['classSearch', 'searchInput'].map((id) => document.getElementById(id)).find((n) => n && n.offsetParent !== null);
      if (search) { event.preventDefault(); search.focus(); }
    }
  });

  // ======================================================================================================================
  root.append(buildAppearance(), buildAccessibility(), buildGeneral(), status);

  document.addEventListener('am:a11ychange', syncAll);
  document.addEventListener('am:prefchange', syncAll);
  document.addEventListener('am:tabchange', (event) => { if (event.detail && event.detail.tab === 'settings') syncAll(); });
  window.addEventListener('storage', syncAll);
  window.AMSettings = { syncAll, readPrefs, isPrefKey, isValidPref };
})();
