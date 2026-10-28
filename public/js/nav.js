/* Attentix tab navigation: Home / Classes / Settings.
   Markup contract: buttons with role="tab" + data-tab="<name>" (aria-controls="panel-<name>") and panels with
   role="tabpanel" id="panel-<name>". Plain script, no dependencies; works without any other page script.
   - Arrow keys, Home and End move between tabs (WAI-ARIA tabs pattern).
   - The URL hash (#home, #classes, #settings) is kept in sync, so a refresh or a shared link lands on the same tab.
     With no hash, the tab chosen under Settings > Application opens (else the first one).
   - A hash that points at an element inside a panel (e.g. #privacyControls) opens that panel and scrolls to it.
   - Any element with data-goto="<name>" switches to that tab.
   - A "view" is a page that belongs to a tab but has no tab of its own: a panel with data-parent="<tab>" (for example
     panel-class, parent "classes"). Its hash is #<view>/<param> (#class/<id>); the parent tab stays highlighted, and
     "Back" links are plain <a href="#classes"> so the browser's own Back button works too.
   window.AMNav.show(name, param) lets page scripts switch tabs or open a view; AMNav.param() is the current view's parameter. */
(function () {
  'use strict';

  const tabs = Array.from(document.querySelectorAll('[role="tab"][data-tab]'));
  if (!tabs.length) return;

  const names = tabs.map((t) => t.dataset.tab);
  const views = {}; // view name -> the tab it belongs to
  document.querySelectorAll('[role="tabpanel"][data-parent]').forEach((panel) => { views[panel.id.replace(/^panel-/, '')] = panel.dataset.parent; });
  const panelOf = (name) => document.getElementById(`panel-${name}`);
  let current = null;
  let currentParam = '';

  function activate(name, { focus = false, updateHash = true, param = '' } = {}) {
    const isView = Object.prototype.hasOwnProperty.call(views, name);
    if (!names.includes(name) && !isView) return false;
    const owner = isView ? views[name] : name;
    Object.keys(views).forEach((view) => { const panel = panelOf(view); if (panel) panel.hidden = view !== name; });
    tabs.forEach((tab) => {
      const on = tab.dataset.tab === owner;
      tab.setAttribute('aria-selected', String(on));
      tab.tabIndex = on ? 0 : -1;
      const panel = panelOf(tab.dataset.tab);
      if (panel) panel.hidden = !on || isView;
      if (on && focus) tab.focus();
    });
    const changed = current !== name || currentParam !== param;
    current = name;
    currentParam = param;
    if (changed) {
      document.dispatchEvent(new window.CustomEvent('am:tabchange', { detail: { tab: name, param } }));
      window.dispatchEvent(new window.Event('resize')); // charts that were hidden pick up their real size
    }
    const hash = `#${name}${param ? `/${encodeURIComponent(param)}` : ''}`;
    if (updateHash && window.location.hash !== hash) {
      try { window.history.replaceState(null, '', hash); } catch { /* sandboxed: the tab still switches */ }
    }
    return true;
  }

  // A hash is a tab name, a view (#class/<id>) or the id of something inside a panel.
  function fromHash() {
    const id = decodeURIComponent((window.location.hash || '').slice(1));
    if (names.includes(id)) { activate(id, { updateHash: false }); return; }
    const [viewName, ...rest] = id.split('/');
    if (Object.prototype.hasOwnProperty.call(views, viewName)) {
      if (rest.join('/')) activate(viewName, { updateHash: false, param: rest.join('/') });
      else activate(views[viewName], { updateHash: false }); // "#class" with no id: the list it belongs to
      return;
    }
    const target = id && document.getElementById(id);
    const panel = target && target.closest('[role="tabpanel"]');
    if (panel) {
      activate(panel.id.replace(/^panel-/, ''), { updateHash: false });
      if (typeof target.scrollIntoView === 'function') target.scrollIntoView({ block: 'start' });
      if (target.tabIndex >= 0 || target.hasAttribute('tabindex')) target.focus({ preventScroll: true });
      return;
    }
    if (!current) activate(startTab(), { updateHash: false });
  }

  // Settings > Application can choose which tab opens when the address names none (stored as JSON by AM.prefs).
  function startTab() {
    try {
      const saved = JSON.parse(window.localStorage.getItem('am.pref.start') || 'null');
      if (names.includes(saved) && saved !== 'settings') return saved;
    } catch { /* storage blocked or corrupt: use the first tab */ }
    return names[0];
  }

  tabs.forEach((tab, index) => {
    tab.addEventListener('click', () => activate(tab.dataset.tab));
    tab.addEventListener('keydown', (event) => {
      const last = tabs.length - 1;
      const move = { ArrowRight: index === last ? 0 : index + 1, ArrowLeft: index === 0 ? last : index - 1, Home: 0, End: last }[event.key];
      if (move === undefined) return;
      event.preventDefault();
      activate(tabs[move].dataset.tab, { focus: true });
    });
  });

  document.addEventListener('click', (event) => {
    const trigger = event.target.closest && event.target.closest('[data-goto]');
    if (!trigger) return;
    event.preventDefault();
    activate(trigger.dataset.goto, { focus: false });
    window.scrollTo(0, 0);
  });

  window.addEventListener('hashchange', fromHash);
  window.AMNav = { show: (name, param) => activate(name, { param: param || '' }), current: () => current, param: () => currentParam, names };
  fromHash();
})();
