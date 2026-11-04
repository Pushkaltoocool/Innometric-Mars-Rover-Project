/**
 * Operations dashboard: scheduler timeline, task table, locks and queues,
 * heap map and kernel log. Colour is semantic only (amber = boosted/degraded,
 * red = fault); task identity comes from rows and names, not hues.
 */
import { TaskState } from '../rtos/kernel.js';

const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const pct = (v) => `${(v * 100).toFixed(0)}%`;
const kib = (b) => `${(b / 1024).toFixed(1)} KiB`;

let palette = null;
function pal() {
  if (palette) return palette;
  const cs = getComputedStyle(document.documentElement);
  const v = (n) => cs.getPropertyValue(n).trim();
  palette = { run: v('--ink-run'), text: v('--text'), text2: v('--text-2'), muted: v('--muted'), line: v('--line'), raise: v('--raise'), warn: v('--warn'), crit: v('--crit'), sel: v('--sel') };
  return palette;
}

const HEAP_TAGS = {
  'TCB+stack': { color: '#5a524a', label: 'Task control blocks and stacks' },
  'Mastcam image': { color: '#b39468', label: 'Mastcam image buffers' },
  'A* open set': { color: '#7f8b86', label: 'A* planner buffer' },
};

export class Dashboard {
  constructor(api, opts) {
    this.api = api;
    this.k = api.k;
    this.opts = opts;
    this.window = 1000;
    this.tab = 'sched';
    this.logFilter = 'all';
    this.lastSlow = 0;
    this._bindTabs();
    this.gantt = $('#gantt');
    for (const b of document.querySelectorAll('[data-window]')) {
      b.addEventListener('click', () => {
        this.window = +b.dataset.window;
        for (const x of document.querySelectorAll('[data-window]')) x.setAttribute('aria-pressed', x === b);
      });
    }
    this.cpuList = $('#cpu-list');
    this.schedStats = $('#sched-stats');
    this.taskBody = $('#task-body');
    this.taskBody.addEventListener('click', (e) => {
      const b = e.target.closest('button[data-act]');
      if (!b) return;
      const t = this.k.getTask(b.dataset.name);
      if (b.dataset.act === 'suspend' && t) this.k.suspend(t);
      if (b.dataset.act === 'resume' && t) this.k.resume(t);
      if (b.dataset.act === 'restart') this.k.restartTask(b.dataset.name);
      this.lastSlow = 0;
    });
    this.queueList = $('#queue-list');
    this.mutexList = $('#mutex-list');
    this.ragSvg = $('#rag');
    this.heapCanvas = $('#heapmap');
    this.heapStats = $('#heap-stats');
    this.heapLegend = $('#heap-legend');
    this.stackList = $('#stack-list');
    this.logList = $('#log-list');
    for (const b of document.querySelectorAll('[data-logf]')) {
      b.addEventListener('click', () => {
        this.logFilter = b.dataset.logf;
        for (const x of document.querySelectorAll('[data-logf]')) x.setAttribute('aria-pressed', x === b);
        this._renderLog();
      });
    }
    this.k.onLog(() => (this._logDirty = true));
  }

  _bindTabs() {
    for (const b of document.querySelectorAll('[data-tab]')) b.addEventListener('click', () => this.setTab(b.dataset.tab));
    try {
      const t = localStorage.getItem('roveros.tab');
      if (t) this.setTab(t);
    } catch {}
  }

  setTab(t) {
    this.tab = t;
    for (const b of document.querySelectorAll('[data-tab]')) b.setAttribute('aria-selected', b.dataset.tab === t);
    for (const p of document.querySelectorAll('[data-pane]')) p.hidden = p.dataset.pane !== t;
    try {
      localStorage.setItem('roveros.tab', t);
    } catch {}
    this.lastSlow = 0;
    this._logDirty = true;
  }

  /* ───────────── Scheduler ───────────── */

  _orderedRows() {
    const live = new Map(this.k.tasks.map((t) => [t.name, t]));
    return this.k.rowNames
      .map((name, row) => ({ name, row, t: live.get(name) }))
      .sort((a, b) => (b.t?.priority ?? -1) - (a.t?.priority ?? -1) || a.row - b.row);
  }

  drawGantt() {
    const P = pal();
    const c = this.gantt;
    const dpr = Math.min(window.devicePixelRatio, 2);
    const rows = this._orderedRows();
    const rowH = 20;
    const top = 18;
    const cssW = c.clientWidth;
    const cssH = top + rows.length * rowH + 20;
    if (c.width !== cssW * dpr || c.height !== cssH * dpr) {
      c.width = cssW * dpr;
      c.height = cssH * dpr;
      c.style.height = cssH + 'px';
    }
    const g = c.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, cssW, cssH);
    const k = this.k;
    const W = this.window;
    const labelW = 128;
    const x0 = labelW;
    const plotW = cssW - labelW;
    const px = plotW / W;
    const end = k.tick;
    const origin = end - W + 1;
    const start = Math.max(1, origin, end - k.cfg.traceLen + 1);
    const L = k.cfg.traceLen;

    // row rules
    g.fillStyle = P.line;
    for (let i = 0; i <= rows.length; i++) g.fillRect(0, top + i * rowH - 0.5, cssW, 1);

    // time axis
    g.font = '10px "Plex Mono", ui-monospace, monospace';
    g.textAlign = 'center';
    const step = W <= 300 ? 50 : W <= 1000 ? 250 : 1000;
    for (let ago = step; ago < W; ago += step) {
      const x = x0 + (W - 1 - ago) * px;
      g.fillStyle = P.line;
      g.fillRect(x, top, 1, rows.length * rowH);
      g.fillStyle = P.muted;
      g.fillText(ago >= 1000 ? `−${ago / 1000} s` : `−${ago} ms`, x, cssH - 5);
    }
    g.textAlign = 'right';
    g.fillStyle = P.muted;
    g.fillText('now', cssW - 1, cssH - 5);

    // interrupt ticks
    g.textAlign = 'left';
    g.font = '11px "Plex Sans", system-ui, sans-serif';
    g.fillStyle = P.muted;
    g.fillText('Interrupts', 0, 11);
    g.fillStyle = P.text2;
    for (let t = start; t <= end; t++) if (k.traceIsr[t % L]) g.fillRect(x0 + (t - origin) * px, 4, Math.max(1, px), 9);

    rows.forEach(({ name, row, t }, i) => {
      const y = top + i * rowH;
      g.font = '11.5px "Plex Mono", ui-monospace, monospace';
      g.fillStyle = t ? P.text2 : P.muted;
      g.textAlign = 'left';
      g.fillText(name, 0, y + 14);
      if (t) {
        const boosted = t.priority !== t.basePriority;
        g.fillStyle = boosted ? P.warn : P.muted;
        g.textAlign = 'right';
        g.fillText(boosted ? `${t.basePriority}→${t.priority}` : String(t.priority), labelW - 12, y + 14);
      }
      const st = k.stateTrace;
      let s = st[(start % L) * 16 + row];
      let runStart = start;
      for (let tk = start + 1; tk <= end + 1; tk++) {
        const v = tk <= end ? st[(tk % L) * 16 + row] : -1;
        if (v === s) continue;
        const xa = x0 + (runStart - origin) * px;
        const w = (tk - runStart) * px;
        if (s === 2 || s === 5) {
          g.fillStyle = s === 5 ? P.warn : P.run;
          g.fillRect(xa, y + 4, Math.max(w, 1), 12);
        } else if (s === 1) {
          g.fillStyle = P.run + '2e';
          g.fillRect(xa, y + 7, w, 6);
        } else if (s === 3) {
          g.fillStyle = P.muted + '80';
          g.fillRect(xa, y + 10, w, 1);
        } else if (s === 4) {
          g.fillStyle = P.sel + '66';
          for (let dx = 0; dx < w; dx += 5) g.fillRect(xa + dx, y + 10, Math.min(2, w - dx), 1);
        }
        s = v;
        runStart = tk;
      }
    });
  }

  _kv(rows) {
    return rows.map(([a, b, cls]) => `<div><dt>${a}</dt><dd class="${cls ?? ''}">${b}</dd></div>`).join('');
  }

  _bar(label, frac, right, cls = '') {
    return `<div class="cpu-row"><span class="nm">${esc(label)}</span><span class="bar"><i class="${cls}" style="width:${Math.min(100, frac * 100)}%"></i></span><span class="num">${right}</span></div>`;
  }

  _slowSched() {
    const k = this.k;
    const tasks = [...k.tasks].sort((a, b) => b.priority - a.priority);
    this.cpuList.innerHTML = tasks.map((t) => this._bar(t.name, t.cpu, `${(t.cpu * 100).toFixed(1)}`, t.priority !== t.basePriority ? 'warn' : '')).join('');
    const cs = k.contextSwitches - (this._lastCs ?? k.contextSwitches);
    const dt = k.tick - (this._lastCsTick ?? k.tick);
    this._lastCs = k.contextSwitches;
    this._lastCsTick = k.tick;
    if (dt > 0) this._csRate = (cs / dt) * 1000;
    const misses = k.tasks.reduce((s, t) => s + t.missed, 0);
    this.schedStats.innerHTML = this._kv([
      ['CPU load', pct(k.cpuLoad), k.cpuLoad > 0.95 ? 'crit-t' : k.cpuLoad > 0.8 ? 'warn-t' : ''],
      ['Context switches per second', Math.round(this._csRate ?? 0)],
      ['Interrupts handled', k.isrCount.toLocaleString()],
      ['Deadline misses', misses, misses ? 'warn-t' : ''],
      ['Scheduling policy', k.cfg.preemptive ? 'Fixed-priority preemptive, time-sliced' : 'Cooperative'],
    ]);
  }

  /* ───────────── Tasks ───────────── */

  _slowTasks() {
    const k = this.k;
    const tasks = [...k.tasks].sort((a, b) => b.priority - a.priority || a.row - b.row);
    this.taskBody.innerHTML = tasks
      .map((t) => {
        const boosted = t.priority !== t.basePriority;
        const used = t.stackPeak / t.stackWords;
        const blockedOn = t.state === TaskState.BLOCKED ? `<small>${t.blockedOn ? `on ${esc(t.blockedOn.name)}` : 'delay'}</small>` : '';
        const acts = t.spec.idle
          ? ''
          : `${t.name === 'SelfMonitor' ? '' : t.state === TaskState.SUSPENDED ? `<button data-act="resume" data-name="${t.name}">Resume</button>` : `<button data-act="suspend" data-name="${t.name}">Suspend</button>`}<button data-act="restart" data-name="${t.name}">Restart</button>`;
        return `<tr>
          <td class="nm">${esc(t.name)}<span class="desc">${esc(t.spec.desc ?? 'Runs when nothing else is ready')}</span></td>
          <td class="num ${boosted ? 'boost' : ''}">${boosted ? `${t.basePriority}→${t.priority}` : t.priority}</td>
          <td><span class="state ${t.state.toLowerCase()}">${t.state}</span>${blockedOn}</td>
          <td class="num">${(t.cpu * 100).toFixed(1)}</td>
          <td><span class="num" style="font-size:11.5px">${t.stackPeak}/${t.stackWords}</span><span class="mini ${used > 0.85 ? 'danger' : used > 0.7 ? 'warn' : ''}"><i style="width:${Math.min(100, used * 100)}%"></i></span></td>
          <td class="num ${t.missed ? 'warn-t' : ''}">${t.missed}</td>
          <td class="num">${t.restarts}</td>
          <td class="acts">${acts}</td>
        </tr>`;
      })
      .join('');
  }

  /* ───────────── Locks & queues ───────────── */

  _slowIpc() {
    const k = this.k;
    this.queueList.innerHTML = k.queues
      .map((q) => {
        const cells = Array.from({ length: q.capacity }, (_, i) => `<i class="${i < q.items.length ? 'on' : ''}"></i>`).join('');
        const waiting = [...q.recvWaiters.map((t) => `<em>${t.name}</em> receiving`), ...q.sendWaiters.map((t) => `<em>${t.name}</em> sending`)].join(', ');
        return `<div class="row">
          <b>${q.name}</b><span class="r num">${q.items.length} of ${q.capacity}</span>
          <div class="q-cells">${cells}</div>
          <span class="sub">Peak ${q.hwm}, sent ${q.sent.toLocaleString()}, <span class="${q.drops ? 'warn-t' : ''}">dropped ${q.drops}</span>${waiting ? `. Blocked: ${waiting}` : ''}</span>
        </div>`;
      })
      .join('');
    this.mutexList.innerHTML = [...k.mutexes, ...k.semaphores]
      .map((m) => {
        const waiters = m.waiters.length ? `Waiting: ${m.waiters.map((t) => `<em>${t.name}</em> (p${t.priority})`).join(', ')}` : '';
        if (m.kind === 'mutex') {
          return `<div class="row ${m.owner ? 'held' : ''}">
            <b>${m.name}</b><span class="r">${m.owner ? `held by <span style="color:var(--text)">${m.owner.name}</span>, ${k.tick - m.heldSince} ms` : 'free'}</span>
            <span class="sub">Mutex. Taken ${m.takes.toLocaleString()} times, contended ${m.contentions}.${waiters ? ' ' + waiters : ''}</span>
          </div>`;
        }
        return `<div class="row"><b>${m.name}</b><span class="r num">${m.count} of ${m.max}</span><span class="sub">Binary semaphore.${waiters ? ' ' + waiters : ''}</span></div>`;
      })
      .join('');
    this._drawRag();
  }

  _drawRag() {
    const P = pal();
    const k = this.k;
    const W = 420;
    const H = 230;
    const cycle = new Set(k.findDeadlock() ?? []);
    const involved = new Set();
    for (const m of k.mutexes) {
      if (m.owner) involved.add(m.owner);
      for (const w of m.waiters) involved.add(w);
    }
    const tasks = [...involved];
    const cx = W / 2;
    const cy = H / 2 - 4;
    const mPos = new Map();
    k.mutexes.forEach((m, i) => {
      const a = (i / k.mutexes.length) * Math.PI * 2 - Math.PI / 2;
      mPos.set(m, [cx + Math.cos(a) * 56, cy + Math.sin(a) * 42]);
    });
    const tPos = new Map();
    tasks.forEach((t, i) => {
      const a = (i / Math.max(1, tasks.length)) * Math.PI * 2 - Math.PI / 2 + 0.4;
      tPos.set(t, [cx + Math.cos(a) * 160, cy + Math.sin(a) * 84]);
    });
    let s = `<defs>
      <marker id="ah" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0,1 L9,5 L0,9 z" fill="${P.muted}"/></marker>
      <marker id="ahr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0,1 L9,5 L0,9 z" fill="${P.crit}"/></marker>
    </defs>`;
    const edge = (a, b, dashed, red, r1, r2) => {
      const dx = b[0] - a[0];
      const dy = b[1] - a[1];
      const L = Math.hypot(dx, dy) || 1;
      return `<line x1="${a[0] + (dx / L) * r1}" y1="${a[1] + (dy / L) * r1}" x2="${b[0] - (dx / L) * r2}" y2="${b[1] - (dy / L) * r2}" stroke="${red ? P.crit : P.muted}" stroke-width="${red ? 1.6 : 1}" ${dashed ? 'stroke-dasharray="3 3"' : ''} marker-end="url(#${red ? 'ahr' : 'ah'})"/>`;
    };
    for (const m of k.mutexes) {
      const mp = mPos.get(m);
      if (m.owner) s += edge(mp, tPos.get(m.owner), false, cycle.has(m.owner) && m.waiters.some((w) => cycle.has(w)), 12, 22);
      for (const w of m.waiters) s += edge(tPos.get(w), mp, true, cycle.has(w), 22, 12);
    }
    for (const m of k.mutexes) {
      const [x, y] = mPos.get(m);
      s += `<rect x="${x - 10}" y="${y - 10}" width="20" height="20" rx="2" class="rag-m ${m.owner ? 'held' : ''}"/><text x="${x}" y="${y + 23}" class="rag-l" text-anchor="middle">${m.name}</text>`;
    }
    for (const t of tasks) {
      const [x, y] = tPos.get(t);
      const red = cycle.has(t);
      s += `<circle cx="${x}" cy="${y}" r="21" fill="${P.raise}" stroke="${red ? P.crit : P.text2}" stroke-width="${red ? 1.6 : 1}"/>
        <text x="${x}" y="${y + 3.5}" class="rag-t" text-anchor="middle">${t.name.length > 10 ? t.name.slice(0, 9) + '…' : t.name}</text>
        <text x="${x}" y="${y + 33}" class="rag-l" text-anchor="middle">prio ${t.priority}</text>`;
    }
    if (!tasks.length) s += `<text x="${cx}" y="${H - 12}" class="rag-l" text-anchor="middle">No mutex is held right now</text>`;
    if (cycle.size) s += `<text x="10" y="18" class="rag-alert">Circular wait: deadlock</text>`;
    this.ragSvg.innerHTML = s;
  }

  /* ───────────── Memory ───────────── */

  _slowMemory() {
    const P = pal();
    const h = this.k.heap;
    const c = this.heapCanvas;
    const dpr = Math.min(window.devicePixelRatio, 2);
    const w = c.clientWidth;
    const H = 40;
    if (c.width !== w * dpr) {
      c.width = w * dpr;
      c.height = H * dpr;
    }
    const g = c.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.fillStyle = P.raise;
    g.fillRect(0, 0, w, H);
    for (const b of h.blocks) {
      if (b.free) continue;
      g.fillStyle = HEAP_TAGS[b.tag]?.color ?? '#6b645c';
      g.fillRect((b.addr / h.size) * w + 0.5, 0, Math.max(1, (b.size / h.size) * w - 1), H);
    }
    const free = h.freeBytes();
    const by = h.usedBy();
    this.heapLegend.innerHTML =
      [...by.entries()].map(([tag, bytes]) => `<span><i style="background:${HEAP_TAGS[tag]?.color ?? '#6b645c'}"></i>${esc(HEAP_TAGS[tag]?.label ?? tag)}, ${kib(bytes)}</span>`).join('') +
      `<span><i style="background:${P.raise};outline:1px solid ${P.line}"></i>Free</span>`;
    this.heapStats.innerHTML = this._kv([
      ['Heap size', kib(h.size)],
      ['Free now', `${kib(free)} (${pct(free / h.size)})`, free / h.size < 0.15 ? 'crit-t' : ''],
      ['Lowest free ever', kib(h.minEverFree)],
      ['Largest free block', kib(h.largestFree())],
      ['Fragmentation', pct(h.fragmentation())],
      ['Allocations, frees, failures', `${h.allocs.toLocaleString()}, ${h.frees.toLocaleString()}, ${h.fails}`, h.fails ? 'warn-t' : ''],
    ]);
    this.stackList.innerHTML = [...this.k.tasks]
      .sort((a, b) => b.priority - a.priority)
      .map((t) => {
        const used = t.stackPeak / t.stackWords;
        return this._bar(t.name, used, `${t.stackPeak}/${t.stackWords}`, used > 0.85 ? 'crit' : used > 0.7 ? 'warn' : '');
      })
      .join('');
  }

  /* ───────────── Log ───────────── */

  _renderLog() {
    const f = this.logFilter;
    const rows = this.k.logs.filter((l) => f === 'all' || (f === 'warn' ? l.level !== 'info' : l.level === 'crit')).slice(-220);
    this.logList.innerHTML = rows
      .reverse()
      .map((l) => `<div class="lg ${l.level}"><span class="t">${(l.tick / 1000).toFixed(3)}</span><span class="s">${esc(l.src)}</span><span class="m">${esc(l.msg)}</span></div>`)
      .join('');
    this._logDirty = false;
  }

  /* ───────────── frame ───────────── */

  update(now) {
    if (this.tab === 'sched') this.drawGantt();
    if (now - this.lastSlow < 200) return;
    this.lastSlow = now;
    if (this.tab === 'sched') this._slowSched();
    if (this.tab === 'tasks') this._slowTasks();
    if (this.tab === 'ipc') this._slowIpc();
    if (this.tab === 'mem') this._slowMemory();
    if (this.tab === 'log' && this._logDirty) this._renderLog();
    const crit = this.k.logs.filter((l) => l.level === 'crit').length;
    const badge = $('#log-badge');
    badge.textContent = crit;
    badge.hidden = !crit;
  }
}
