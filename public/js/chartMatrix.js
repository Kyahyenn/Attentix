/* Chart.js configuration matrix.
   Every chart is fed ONE plain JSON dataset - { labels: string[], values: number[] } - and MATRIX turns that same
   dataset into a line, bar or doughnut configuration. A `kind: 'trend'` chart is a single time series (class average,
   or one student's score): line only, fixed 0-100 axis, optional dashed threshold line. Switching type rebuilds the chart from the cached dataset, so
   nothing has to be re-fetched and the numbers can never drift between views. Colours come from the CSS theme tokens
   and the chart rebuilds itself when the theme (am:themechange) or the text size (am:scalechange) changes. */
(function () {
  'use strict';

  const TYPES = [
    { id: 'line', label: 'Line' },
    { id: 'bar', label: 'Bar' },
    { id: 'doughnut', label: 'Doughnut' }
  ];
  const TYPE_IDS = TYPES.map((t) => t.id);
  const FALLBACK_COLORS = ['#1a5cff', '#c2410c', '#0f766e', '#7c3aed'];
  const ANIMATION_MS = 350;

  // ---- theme ----------------------------------------------------------------------------------------------
  // Canvas drawing cannot read CSS variables, so resolve the tokens to concrete colours at build time.
  function themeContext(palette) {
    const css = getComputedStyle(document.documentElement);
    const token = (name, fallback) => css.getPropertyValue(name).trim() || fallback;
    const rootPx = parseFloat(css.fontSize) || 16;
    return {
      text: token('--text', '#172033'),
      muted: token('--muted', '#55607a'),
      grid: token('--line', '#dbe2ee'),
      surface: token('--card-alt', '#f0f4fb'),
      accent: token('--accent', '#1a5cff'),
      accentSoft: token('--accent-soft', '#eaf1ff'),
      segments: palette.map((name, i) => token(name, FALLBACK_COLORS[i % FALLBACK_COLORS.length])),
      fontPx: Math.round(rootPx * 0.8125) // 13px at 100% text size, grows with the A+ / A- setting
    };
  }

  // ---- the matrix: type -> (dataset, theme, label) => Chart.js config ----------------------------------------
  const cartesianScales = (t, opts = {}) => ({
    x: { grid: { display: false }, ticks: { color: t.muted } },
    y: { beginAtZero: true, grace: '10%', ...(opts.yMax !== undefined ? { max: opts.yMax, grace: 0 } : {}), ticks: { precision: 0, color: t.muted }, grid: { color: t.grid } }
  });

  const MATRIX = {
    line: (data, t, label, opts) => ({
      type: 'line',
      data: {
        labels: data.labels,
        datasets: [{
          label, data: data.values, borderColor: t.accent, borderWidth: 3, tension: 0.25,
          pointRadius: 6, pointHoverRadius: 8, pointBackgroundColor: t.segments, pointBorderColor: t.surface, pointBorderWidth: 2
        }]
      },
      options: { scales: cartesianScales(t, opts), plugins: { legend: { display: false } } }
    }),
    bar: (data, t, label, opts) => ({
      type: 'bar',
      data: { labels: data.labels, datasets: [{ label, data: data.values, backgroundColor: t.segments, borderRadius: 6, maxBarThickness: 64 }] },
      options: { scales: cartesianScales(t, opts), plugins: { legend: { display: false } } }
    }),
    doughnut: (data, t, label) => ({
      type: 'doughnut',
      data: { labels: data.labels, datasets: [{ label, data: data.values, backgroundColor: t.segments, borderColor: t.surface, borderWidth: 2 }] },
      options: { cutout: '58%', plugins: { legend: { position: 'bottom', labels: { color: t.text, boxWidth: 14 } } } }
    }),
    // One time series. Points are hidden once the series is long so the line stays readable; the optional dashed
    // dataset is the "check-in suggested" threshold. Same data shape as every other type: { labels, values }.
    trend: (data, t, label, opts = {}) => {
      const datasets = [{
        label, data: data.values, borderColor: t.accent, backgroundColor: t.accentSoft, fill: true, borderWidth: 3, tension: 0.25,
        pointRadius: data.values.length > 40 ? 0 : 3, pointHoverRadius: 6, pointBackgroundColor: t.accent
      }];
      if (opts.threshold !== undefined) {
        datasets.push({
          label: opts.thresholdLabel || `Threshold (${opts.threshold})`, data: data.values.map(() => opts.threshold),
          borderColor: t.muted, borderDash: [6, 4], borderWidth: 2, pointRadius: 0, pointHoverRadius: 0, fill: false
        });
      }
      return {
        type: 'line',
        data: { labels: data.labels, datasets },
        options: {
          interaction: { mode: 'index', intersect: false },
          scales: {
            x: { grid: { display: false }, ticks: { color: t.muted, maxTicksLimit: 6, maxRotation: 0 } },
            y: { min: 0, max: opts.yMax !== undefined ? opts.yMax : 100, ticks: { precision: 0, color: t.muted }, grid: { color: t.grid } }
          },
          plugins: { legend: { display: opts.threshold !== undefined, position: 'bottom', labels: { color: t.text, boxWidth: 14 } } }
        }
      };
    }
  };

  // ---- storage / helpers ---------------------------------------------------------------------------------
  const readType = (key, fallback) => {
    try { const saved = window.localStorage.getItem(key); return TYPE_IDS.includes(saved) ? saved : fallback; } catch { return fallback; }
  };
  const writeType = (key, type) => { try { window.localStorage.setItem(key, type); } catch { /* not persisted */ } };
  // Settings > Accessibility > Reduce motion wins; without it (or without a11y.js) the operating system decides.
  const prefersReducedMotion = () => (window.AMA11y && window.AMA11y.motion
    ? window.AMA11y.motion() === 'reduce'
    : Boolean(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches));
  const isDataset = (d) => d && Array.isArray(d.labels) && Array.isArray(d.values) && d.labels.length === d.values.length;

  const NOOP = { update() {}, setType() {}, getType: () => null, destroy() {} };

  /**
   * @param {object} options
   *   canvas       <canvas> element (required)
   *   switcher     optional container; a radio-group of type buttons is rendered into it
   *   storageKey   localStorage key remembering the chosen type for this chart
   *   defaultType  'line' | 'bar' | 'doughnut'
   *   noun         what the chart shows, used in the accessible description ("Student status")
   *   datasetLabel series name used in tooltips
   *   palette      CSS variable names, one per data point, e.g. ['--good', '--warn', '--muted']
   *   kind         'trend' = single time series, line only, no type switcher (default: the three-type matrix)
   *   yMax         fixed top of the value axis (e.g. 100 for scores)
   *   threshold    trend only: draws a dashed reference line at this value; thresholdLabel names it in the legend
   */
  function createMatrixChart(options) {
    const { canvas, switcher, storageKey, noun = 'Chart', datasetLabel = 'Value', palette = ['--chart-1', '--chart-2', '--chart-3', '--chart-4'], kind, yMax, threshold, thresholdLabel } = options || {};
    if (!canvas) return NOOP;

    const isTrend = kind === 'trend';
    const chartOpts = { yMax, threshold, thresholdLabel };
    let type = isTrend ? 'line' : readType(storageKey, TYPE_IDS.includes(options.defaultType) ? options.defaultType : 'bar');
    let data = { labels: [], values: [] };
    let lastKey = '';
    let chart = null;
    let buttons = [];

    // Screen readers cannot see a canvas: keep an up-to-date text equivalent of the numbers on it.
    function describe() {
      const typeLabel = TYPES.find((t) => t.id === type).label.toLowerCase();
      let points;
      if (data.labels.length > 12) { // a long series is summarised: reading 90 points aloud helps nobody
        points = `${data.labels.length} samples from ${data.labels[0]} to ${data.labels[data.labels.length - 1]}. Latest ${data.values[data.values.length - 1]}, lowest ${Math.min(...data.values)}, highest ${Math.max(...data.values)}.`;
      } else points = data.labels.map((label, i) => `${label} ${data.values[i]}`).join(', ');
      const summary = `${noun}, ${typeLabel} chart. ${points || 'No data yet.'}`;
      canvas.setAttribute('role', 'img');
      canvas.setAttribute('aria-label', summary);
      canvas.textContent = summary; // fallback content for browsers without canvas
    }

    function destroyChart() { if (chart) { chart.destroy(); chart = null; } }

    function build(animate) {
      destroyChart();
      if (typeof Chart === 'undefined') return;
      const theme = themeContext(palette);
      Chart.defaults.color = theme.muted;
      Chart.defaults.borderColor = theme.grid;
      Chart.defaults.font.size = theme.fontPx;

      const config = (isTrend ? MATRIX.trend : MATRIX[type])(data, theme, datasetLabel, chartOpts);
      config.options = {
        responsive: true,
        maintainAspectRatio: false,
        // Only a (re)build animates, and never for users who asked for reduced motion. Live data updates use
        // update('none') below, so a chart never re-tweens every second.
        animation: animate && !prefersReducedMotion() ? { duration: ANIMATION_MS } : false,
        ...config.options
      };
      chart = new Chart(canvas.getContext('2d'), config);
    }

    function syncSwitcher() {
      buttons.forEach((b) => {
        const active = b.dataset.type === type;
        b.setAttribute('aria-checked', String(active));
        b.tabIndex = active ? 0 : -1; // roving tabindex: one Tab stop for the whole group
        b.classList.toggle('is-active', active);
      });
    }

    function setType(next) {
      if (isTrend || !TYPE_IDS.includes(next) || next === type) return; // a trend chart is always a line
      type = next;
      writeType(storageKey, type);
      describe();
      syncSwitcher();
      build(true);
    }

    function update(next) {
      if (!isDataset(next)) return;
      const key = JSON.stringify(next);
      if (key === lastKey) return; // identical numbers: nothing to redraw
      lastKey = key;
      data = { labels: next.labels.slice(), values: next.values.slice() };
      describe();
      if (!chart) { build(false); return; }
      chart.data.labels = data.labels;
      chart.data.datasets[0].data = data.values;
      if (isTrend) {
        chart.data.datasets[0].pointRadius = data.values.length > 40 ? 0 : 3;
        if (chart.data.datasets[1]) chart.data.datasets[1].data = data.values.map(() => threshold);
      }
      chart.update('none');
    }

    function mountSwitcher() {
      if (!switcher || isTrend) return;
      switcher.classList.add('segmented');
      switcher.setAttribute('role', 'radiogroup');
      switcher.setAttribute('aria-label', `Chart type for ${noun.toLowerCase()}`);
      buttons = TYPES.map(({ id, label }) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'segment';
        b.dataset.type = id;
        b.setAttribute('role', 'radio');
        b.textContent = label;
        b.addEventListener('click', () => setType(id));
        return b;
      });
      switcher.replaceChildren(...buttons);
      // Arrow keys / Home / End move AND select, as a native radio group does.
      switcher.addEventListener('keydown', (event) => {
        const at = TYPE_IDS.indexOf(type);
        const target = { ArrowRight: at + 1, ArrowDown: at + 1, ArrowLeft: at - 1, ArrowUp: at - 1, Home: 0, End: TYPE_IDS.length - 1 }[event.key];
        if (target === undefined) return;
        event.preventDefault();
        const next = TYPE_IDS[(target + TYPE_IDS.length) % TYPE_IDS.length];
        setType(next);
        buttons.find((b) => b.dataset.type === next).focus();
      });
      syncSwitcher();
    }

    // Canvas colours and font size are baked in when drawn, so rebuild when the theme or text size changes.
    const rebuild = () => { if (chart) build(false); };
    document.addEventListener('am:themechange', rebuild);
    document.addEventListener('am:scalechange', rebuild);

    // Chart.js follows its container on screen, but print layout changes the width without a resize event: redraw for it.
    const resize = () => { if (chart && typeof chart.resize === 'function') chart.resize(); };
    window.addEventListener('beforeprint', resize);
    window.addEventListener('afterprint', resize);

    mountSwitcher();
    describe();

    return {
      update,
      setType,
      getType: () => type,
      destroy() {
        destroyChart();
        document.removeEventListener('am:themechange', rebuild);
        document.removeEventListener('am:scalechange', rebuild);
        window.removeEventListener('beforeprint', resize);
        window.removeEventListener('afterprint', resize);
      }
    };
  }

  window.AMCharts = { createMatrixChart, TYPES, MATRIX };
})();
