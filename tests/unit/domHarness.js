/** Boots a REAL page from public/ (its actual HTML + scripts) in jsdom with a scripted fetch. Not a test file. */
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const PUBLIC = path.join(__dirname, '../../public');
const read = (file) => fs.readFileSync(path.join(PUBLIC, file), 'utf8');

const windows = [];
const cleanup = () => windows.splice(0).forEach((w) => w.close());

// routes: "METHOD /path" -> { status, body } | (body, headers) => { status, body }
const boot = ({ page, url, routes = {}, scripts = [], setup }) => {
  const dom = new JSDOM(read(page), {
    url, runScripts: 'outside-only', pretendToBeVisual: true,
    beforeParse(window) {
      window.matchMedia = (q) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} });
      window.HTMLCanvasElement.prototype.getContext = () => ({});
    }
  });
  const { window } = dom;
  windows.push(window);

  const calls = [];
  window.fetch = async (u, init = {}) => {
    const method = init.method || 'GET';
    const key = `${method} ${u}`;
    const body = init.body ? JSON.parse(init.body) : undefined;
    const headers = init.headers || {};
    calls.push({ key, body, headers });
    const route = routes[key];
    if (!route) return { ok: false, status: 404, json: async () => ({ error: `unrouted ${key}` }) };
    const out = typeof route === 'function' ? await route(body, headers) : route;
    return { ok: out.status < 400, status: out.status, json: async () => out.body };
  };

  window.eval(read('js/common.js'));
  const navigations = [];
  window.AM.navigate = (to) => navigations.push(to);
  if (setup) setup(window);
  scripts.forEach((script) => window.eval(read(`js/${script}`)));

  const $ = (selector) => window.document.querySelector(selector);
  const byId = (id) => window.document.getElementById(id);
  const tick = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));
  const type = (id, value) => { byId(id).value = value; };
  const submit = (id) => byId(id).dispatchEvent(new window.Event('submit', { cancelable: true, bubbles: true }));
  return { window, calls, navigations, $, byId, tick, type, submit };
};

// A Chart.js stand-in that records every config it is given.
const stubChart = (window, instances = []) => {
  window.Chart = class {
    constructor(ctx, config) { this.config = config; this.data = config.data; this.updates = []; instances.push(this); }
    update(mode) { this.updates.push(mode); }
    resize() {}
    destroy() {}
  };
  window.Chart.defaults = { font: {} };
  return instances;
};

// A valid-looking (not cryptographically valid) token: the client only checks the shape.
const FAKE_TOKEN = `${'a'.repeat(40)}.${'b'.repeat(43)}`;

module.exports = { boot, cleanup, read, stubChart, FAKE_TOKEN };
