/** Runs the real public/js/chartMatrix.js in jsdom against a stub Chart class that records every config it is given. */
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const SOURCE = fs.readFileSync(path.join(__dirname, '../../public/js/chartMatrix.js'), 'utf8');
const windows = [];
afterEach(() => windows.splice(0).forEach((w) => w.close()));

const boot = ({ reducedMotion = false, stored = {} } = {}) => {
  const dom = new JSDOM('<!doctype html><html style="font-size:16px"><body><div id="sw"></div><canvas id="c"></canvas></body></html>', {
    url: 'http://localhost/', runScripts: 'outside-only', pretendToBeVisual: true,
    beforeParse(window) {
      Object.entries(stored).forEach(([k, v]) => window.localStorage.setItem(k, v));
      window.matchMedia = (q) => ({ matches: reducedMotion && q.includes('reduce'), media: q, addEventListener() {}, removeEventListener() {} });
      window.HTMLCanvasElement.prototype.getContext = () => ({});
    }
  });
  const { window } = dom;
  windows.push(window);
  const instances = [];
  window.Chart = class {
    constructor(ctx, config) { this.config = config; this.data = config.data; this.updates = []; this.destroyed = false; instances.push(this); }
    update(mode) { this.updates.push(mode); }
    destroy() { this.destroyed = true; }
  };
  window.Chart.defaults = { font: {} };
  window.eval(SOURCE);
  const $ = (s) => window.document.querySelector(s);
  const make = (extra = {}) => window.AMCharts.createMatrixChart({
    canvas: $('#c'), switcher: $('#sw'), storageKey: 'am.chart.test', defaultType: 'doughnut',
    noun: 'Student status', datasetLabel: 'Students', palette: ['--good', '--warn', '--muted'], ...extra
  });
  const radios = () => [...window.document.querySelectorAll('#sw [role="radio"]')];
  return { window, instances, make, radios, $ };
};

const DATA = { labels: ['On track', 'Check-in suggested', 'Offline'], values: [5, 2, 1] };

describe('configuration matrix', () => {
  test('one dataset yields line, bar and doughnut configs that carry exactly the same numbers', () => {
    const { window } = boot();
    const theme = { text: '#000', muted: '#555', grid: '#ddd', surface: '#eee', accent: '#00f', segments: ['#0a0', '#a60', '#888'], fontPx: 13 };
    const { MATRIX } = window.AMCharts;
    const cfg = Object.fromEntries(['line', 'bar', 'doughnut'].map((t) => [t, MATRIX[t](DATA, theme, 'Students')]));
    expect(Object.values(cfg).map((c) => c.type)).toEqual(['line', 'bar', 'doughnut']);
    for (const c of Object.values(cfg)) {
      expect(c.data.labels).toEqual(DATA.labels);
      expect(c.data.datasets[0].data).toEqual(DATA.values);
    }
    expect(cfg.line.options.scales.y.beginAtZero).toBe(true);
    expect(cfg.bar.options.scales.x).toBeDefined();
    expect(cfg.doughnut.options.scales).toBeUndefined(); // radial: no axes
    expect(cfg.doughnut.options.plugins.legend.position).toBe('bottom');
    expect(cfg.bar.data.datasets[0].backgroundColor).toEqual(theme.segments);
  });
});

describe('createMatrixChart', () => {
  test('toggling line -> bar -> doughnut rebuilds from the same cached JSON, with no new data call', () => {
    const t = boot();
    const chart = t.make({ defaultType: 'line' });
    chart.update(DATA);
    expect(t.instances).toHaveLength(1);
    expect(t.instances[0].config.type).toBe('line');

    chart.setType('bar');
    chart.setType('doughnut');
    expect(t.instances.map((i) => i.config.type)).toEqual(['line', 'bar', 'doughnut']);
    expect(t.instances.slice(0, 2).every((i) => i.destroyed)).toBe(true);
    expect(t.instances.map((i) => i.config.data.datasets[0].data)).toEqual([DATA.values, DATA.values, DATA.values]);
    expect(chart.getType()).toBe('doughnut');
  });

  test('live updates patch the existing chart without animation and skip identical data', () => {
    const t = boot();
    const chart = t.make({ defaultType: 'bar' });
    chart.update(DATA);
    chart.update({ ...DATA, values: [4, 3, 1] });
    expect(t.instances).toHaveLength(1);
    expect(t.instances[0].data.datasets[0].data).toEqual([4, 3, 1]);
    expect(t.instances[0].updates).toEqual(['none']);
    chart.update({ ...DATA, values: [4, 3, 1] });
    expect(t.instances[0].updates).toEqual(['none']); // unchanged numbers: no redraw
  });

  test('only a rebuild animates, and never when the user prefers reduced motion', () => {
    const normal = boot();
    const a = normal.make({ defaultType: 'bar' });
    a.update(DATA);
    expect(normal.instances[0].config.options.animation).toBe(false); // first paint of live data
    a.setType('line');
    expect(normal.instances[1].config.options.animation).toEqual({ duration: 350 });

    const reduced = boot({ reducedMotion: true });
    const b = reduced.make({ defaultType: 'bar' });
    b.update(DATA);
    b.setType('line');
    expect(reduced.instances[1].config.options.animation).toBe(false);
  });

  test('the chosen type is remembered, and a junk stored value falls back to the default', () => {
    const t = boot();
    t.make({ defaultType: 'line' }).setType('bar');
    expect(t.window.localStorage.getItem('am.chart.test')).toBe('bar');
    expect(boot({ stored: { 'am.chart.test': 'bar' } }).make({ defaultType: 'line' }).getType()).toBe('bar');
    expect(boot({ stored: { 'am.chart.test': 'pie3d' } }).make({ defaultType: 'line' }).getType()).toBe('line');
    expect(t.make({ defaultType: 'nonsense' }).getType()).toBe('bar');
  });

  test('rejects unknown types and malformed datasets instead of breaking the chart', () => {
    const t = boot();
    const chart = t.make({ defaultType: 'bar' });
    chart.update(DATA);
    chart.setType('radar');
    expect(chart.getType()).toBe('bar');
    chart.update({ labels: ['a', 'b'], values: [1] });
    chart.update(null);
    chart.update({ labels: 'x', values: 'y' });
    expect(t.instances).toHaveLength(1);
    expect(t.instances[0].updates).toEqual([]);
  });

  test('theme and text-size changes rebuild the chart with fresh colours/fonts', () => {
    const t = boot();
    t.make({ defaultType: 'bar' }).update(DATA);
    t.window.document.documentElement.style.setProperty('--good', '#123456');
    t.window.document.dispatchEvent(new t.window.CustomEvent('am:themechange'));
    expect(t.instances).toHaveLength(2);
    expect(t.instances[1].config.data.datasets[0].backgroundColor[0]).toBe('#123456');
    t.window.document.documentElement.style.fontSize = '32px';
    t.window.document.dispatchEvent(new t.window.CustomEvent('am:scalechange'));
    expect(t.window.Chart.defaults.font.size).toBe(26); // 32px * 0.8125
  });

  test('destroy() stops listening for theme changes', () => {
    const t = boot();
    const chart = t.make({ defaultType: 'bar' });
    chart.update(DATA);
    chart.destroy();
    t.window.document.dispatchEvent(new t.window.CustomEvent('am:themechange'));
    expect(t.instances).toHaveLength(1);
  });

  test('without Chart.js loaded it degrades to an accessible text description', () => {
    const t = boot();
    delete t.window.Chart;
    const chart = t.make({ defaultType: 'bar' });
    expect(() => { chart.update(DATA); chart.setType('line'); }).not.toThrow();
    expect(t.$('#c').getAttribute('aria-label')).toContain('On track 5');
  });
});

describe('accessibility of the type switcher and the canvas', () => {
  test('is a radiogroup with one tab stop (roving tabindex) and a checked option', () => {
    const t = boot();
    t.make({ defaultType: 'bar' });
    expect(t.$('#sw').getAttribute('role')).toBe('radiogroup');
    expect(t.$('#sw').getAttribute('aria-label')).toBe('Chart type for student status');
    expect(t.radios().map((r) => r.textContent)).toEqual(['Line', 'Bar', 'Doughnut']);
    expect(t.radios().map((r) => r.getAttribute('aria-checked'))).toEqual(['false', 'true', 'false']);
    expect(t.radios().map((r) => r.tabIndex)).toEqual([-1, 0, -1]);
  });

  test('arrow keys / Home / End move and select, wrapping at the ends', () => {
    const t = boot();
    const chart = t.make({ defaultType: 'bar' });
    chart.update(DATA);
    const press = (key) => t.$('#sw').dispatchEvent(new t.window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
    press('ArrowRight'); expect(chart.getType()).toBe('doughnut');
    press('ArrowRight'); expect(chart.getType()).toBe('line');
    press('ArrowLeft'); expect(chart.getType()).toBe('doughnut');
    press('Home'); expect(chart.getType()).toBe('line');
    press('End'); expect(chart.getType()).toBe('doughnut');
    expect(t.radios().find((r) => r.getAttribute('aria-checked') === 'true').textContent).toBe('Doughnut');
    expect(t.window.document.activeElement.textContent).toBe('Doughnut');
  });

  test('the canvas always carries a text equivalent of the current numbers and chart type', () => {
    const t = boot();
    const chart = t.make({ defaultType: 'doughnut' });
    expect(t.$('#c').getAttribute('aria-label')).toMatch(/No data yet/);
    chart.update(DATA);
    expect(t.$('#c').getAttribute('aria-label')).toBe('Student status, doughnut chart. On track 5, Check-in suggested 2, Offline 1');
    chart.setType('line');
    expect(t.$('#c').getAttribute('aria-label')).toMatch(/line chart/);
    expect(t.$('#c').getAttribute('role')).toBe('img');
  });
});

describe('trend charts (class average / personal score)', () => {
  const SERIES = { labels: ['10:00:00', '10:00:05', '10:00:10'], values: [70, 64, 58] };
  const make = (t, extra = {}) => t.make({ kind: 'trend', switcher: null, defaultType: 'line', yMax: 100, threshold: 60, thresholdLabel: 'Check-in threshold (60)', ...extra });

  test('is always a line with a fixed 0-100 axis and a dashed threshold dataset', () => {
    const t = boot();
    const chart = make(t);
    chart.update(SERIES);
    const cfg = t.instances[0].config;
    expect(cfg.type).toBe('line');
    expect(cfg.data.datasets[0].data).toEqual(SERIES.values);
    expect(cfg.data.datasets[1].data).toEqual([60, 60, 60]);
    expect(cfg.data.datasets[1].borderDash).toEqual([6, 4]);
    expect(cfg.options.scales.y.min).toBe(0);
    expect(cfg.options.scales.y.max).toBe(100);
    expect(cfg.options.plugins.legend.display).toBe(true);
  });

  test('setType is ignored (no switcher either) and live updates patch both datasets without animating', () => {
    const t = boot();
    const chart = make(t, { switcher: t.$('#sw') });
    chart.update(SERIES);
    chart.setType('bar');
    expect(chart.getType()).toBe('line');
    expect(t.radios()).toHaveLength(0);
    chart.update({ labels: [...SERIES.labels, '10:00:15'], values: [...SERIES.values, 55] });
    expect(t.instances).toHaveLength(1);
    expect(t.instances[0].data.datasets[0].data).toEqual([70, 64, 58, 55]);
    expect(t.instances[0].data.datasets[1].data).toEqual([60, 60, 60, 60]);
    expect(t.instances[0].updates).toEqual(['none']);
  });

  test('without a threshold there is one dataset and no legend; long series hide points and are described compactly', () => {
    const t = boot();
    const chart = make(t, { threshold: undefined });
    const labels = Array.from({ length: 50 }, (_, i) => `t${i}`);
    const values = labels.map((_, i) => i);
    chart.update({ labels, values });
    const cfg = t.instances[0].config;
    expect(cfg.data.datasets).toHaveLength(1);
    expect(cfg.options.plugins.legend.display).toBe(false);
    expect(cfg.data.datasets[0].pointRadius).toBe(0);
    expect(t.$('#c').getAttribute('aria-label')).toBe('Student status, line chart. 50 samples from t0 to t49. Latest 49, lowest 0, highest 49.');
  });

  test('redraws for print (beforeprint/afterprint) and stops listening after destroy()', () => {
    const t = boot();
    const chart = make(t);
    chart.update(SERIES);
    const resize = jest.fn();
    t.instances[0].resize = resize;
    t.window.dispatchEvent(new t.window.Event('beforeprint'));
    t.window.dispatchEvent(new t.window.Event('afterprint'));
    expect(resize).toHaveBeenCalledTimes(2);
    chart.destroy();
    t.window.dispatchEvent(new t.window.Event('beforeprint'));
    expect(resize).toHaveBeenCalledTimes(2);
  });

  test('the standard matrix can pin the value axis too (yMax)', () => {
    const t = boot();
    const chart = t.make({ defaultType: 'bar', yMax: 100 });
    chart.update(DATA);
    expect(t.instances[0].config.options.scales.y.max).toBe(100);
  });
});
