import { MarsScene } from './world/scene.js';
import { RoverSim } from './world/rover-sim.js';
import { rocks, addRock, rebuildGrid, stampRock } from './world/terrain.js';
import { createRoverSystem } from './rover/system.js';
import { SCENARIOS, Director } from './rover/scenarios.js';
import { Dashboard } from './ui/dashboard.js';

const $ = (s) => document.querySelector(s);

/* ───────────── simulation ───────────── */
rebuildGrid();
const rover = new RoverSim();
const api = createRoverSystem(rover);
const { k, sys } = api;
const ui = { speed: 1, inheritance: true, showFov: true };

const scene = new MarsScene($('#viewport'));
const dash = new Dashboard(api, ui);

/* ───────────── narrator ───────────── */
const narrator = $('#narrator');
function say(text, kind = 'info', label) {
  const d = document.createElement('div');
  d.className = `nar ${kind}`;
  const labels = { info: 'Rover', hazard: 'Hazard avoidance', fault: 'Fault', deadlock: 'Deadlock', inversion: 'Priority inversion', recover: 'Recovered', power: 'Power', nav: 'AutoNav', crash: 'Collision', scenario: 'Scenario' };
  d.innerHTML = `<small>${label ?? labels[kind] ?? kind}</small>${text}`;
  narrator.prepend(d);
  while (narrator.children.length > 2) narrator.lastChild.remove();
  setTimeout(() => {
    d.style.opacity = '0';
    setTimeout(() => d.remove(), 700);
  }, 7000);
}

rover.on('collision', (c) => {
  k.log('crit', 'HW', `COLLISION with rock at ${c.speed.toFixed(1)} m/s. Wheel/suspension damage likely.`);
  say(`The rover hit a rock at ${c.speed.toFixed(1)} m/s. Nothing stopped it in time.`, 'crash');
  scene.shake = 0.6;
  const f = $('#flash');
  f.classList.add('on');
  setTimeout(() => f.classList.remove('on'), 120);
});

/* ───────────── scenarios ───────────── */
const scripted = [];
const director = new Director({
  api,
  sys,
  rover,
  ui,
  say: (t) => say(t, 'scenario'),
  resetRover(x, z, yaw) {
    Object.assign(rover, { x, z, yaw, v: 0, yawRate: 0 });
    rover.target.speed = 0;
    rover.target.steer = 0;
    sys.mode = 'manual';
    sys.path = null;
    sys.waypoint = null;
    api.command({ type: 'estop' });
    scene.trackLast = null;
  },
  spawnRock(x, z, r) {
    const rock = addRock(x, z, r, true);
    stampRock(rock);
    scripted.push(rock);
    scene.addScriptedRock(rock);
  },
  clearScripted() {
    for (const r of scripted) {
      rocks.splice(rocks.indexOf(r), 1);
      scene.removeScriptedRock(r);
    }
    if (scripted.length) rebuildGrid();
    scripted.length = 0;
  },
});

const scnTabs = $('#scn-tabs');
const scnDesc = $('#scn-desc');
const scnActions = $('#scn-actions');
let selected = SCENARIOS[0];
scnTabs.innerHTML = SCENARIOS.map((s) => `<button data-id="${s.id}">${s.title}</button>`).join('');
function renderScenario() {
  const a = director.active;
  for (const b of scnTabs.children) {
    b.setAttribute('aria-pressed', b.dataset.id === selected.id);
    b.classList.toggle('running', a?.scn.id === b.dataset.id);
  }
  scnDesc.innerHTML = `<b>${selected.concept}</b>${selected.blurb}`;
  if (a && a.scn === selected) {
    scnActions.innerHTML = `<span class="prog"><i id="scn-prog"></i></span><button data-act="stop">Stop</button>`;
  } else if (selected.fix) {
    scnActions.innerHTML = `<button data-act="run" data-fix="0">Run without ${selected.fix.toLowerCase()}</button><button class="primary" data-act="run" data-fix="1">Run with ${selected.fix.toLowerCase()}</button>`;
  } else {
    scnActions.innerHTML = `<button class="primary" data-act="run" data-fix="1">Inject fault</button>`;
  }
}
scnTabs.addEventListener('click', (e) => {
  const b = e.target.closest('button[data-id]');
  if (!b) return;
  selected = SCENARIOS.find((x) => x.id === b.dataset.id);
  renderScenario();
});
scnActions.addEventListener('click', (e) => {
  const b = e.target.closest('button[data-act]');
  if (!b) return;
  if (b.dataset.act === 'stop') director.stop();
  else {
    director.start(selected, b.dataset.fix === '1');
    if (ui.speed === 0) setSpeed(1);
  }
});
director.onChange(() => {
  renderScenario();
  syncCfg();
});

/* ───────────── kernel config toggles ───────────── */
const cfgPreempt = $('#cfg-preempt');
const cfgInherit = $('#cfg-inherit');
const cfgOrder = $('#cfg-order');
const cfgShed = $('#cfg-shed');
function syncCfg() {
  cfgPreempt.checked = k.cfg.preemptive;
  cfgInherit.checked = k.cfg.priorityInheritance;
  cfgOrder.checked = sys.lockOrdering;
  cfgShed.checked = sys.loadShedding;
}
cfgPreempt.addEventListener('change', () => {
  k.cfg.preemptive = cfgPreempt.checked;
  k.log('warn', 'config', `configUSE_PREEMPTION = ${cfgPreempt.checked ? 1 : 0}`);
});
cfgInherit.addEventListener('change', () => {
  ui.inheritance = cfgInherit.checked;
  api.setPriorityInheritance(cfgInherit.checked);
  k.log('warn', 'config', `Mutex priority inheritance ${cfgInherit.checked ? 'enabled' : 'disabled'}`);
});
cfgOrder.addEventListener('change', () => {
  sys.lockOrdering = cfgOrder.checked;
  k.log('warn', 'config', `Lock-ordering policy ${cfgOrder.checked ? 'enforced' : 'off'}`);
});
cfgShed.addEventListener('change', () => {
  sys.loadShedding = cfgShed.checked;
  k.log('warn', 'config', `Load shedding ${cfgShed.checked ? 'enabled' : 'disabled'}`);
});

/* ───────────── top bar ───────────── */
function setSpeed(v) {
  ui.speed = v;
  for (const b of document.querySelectorAll('[data-speed]')) b.setAttribute('aria-pressed', +b.dataset.speed === v);
}
for (const b of document.querySelectorAll('[data-speed]')) b.addEventListener('click', () => setSpeed(+b.dataset.speed));
const CAMS = ['chase', 'orbit', 'mastcam', 'top'];
function setCam(m) {
  scene.setCameraMode(m);
  for (const b of document.querySelectorAll('[data-cam]')) b.setAttribute('aria-pressed', b.dataset.cam === m);
}
for (const b of document.querySelectorAll('[data-cam]')) b.addEventListener('click', () => setCam(b.dataset.cam));

function setHelp(show) {
  $('#help').classList.toggle('hidden', !show);
  $('#help-open').hidden = show;
}
$('#help-x').addEventListener('click', () => setHelp(false));
$('#help-open').addEventListener('click', () => setHelp(true));

/* ───────────── input → interrupts ───────────── */
const keys = new Set();
let lastDrive = '0,0';
function pushDrive() {
  const f = keys.has('KeyW') || keys.has('ArrowUp');
  const b = keys.has('KeyS') || keys.has('ArrowDown');
  const l = keys.has('KeyA') || keys.has('ArrowLeft');
  const r = keys.has('KeyD') || keys.has('ArrowRight');
  const throttle = (f ? 1 : 0) - (b ? 1 : 0);
  const steer = (l ? 1 : 0) - (r ? 1 : 0);
  const key = `${throttle},${steer}`;
  if (key === lastDrive) return;
  lastDrive = key;
  api.command({ type: 'drive', throttle, steer });
}
const DRIVE_KEYS = new Set(['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']);
window.addEventListener('keydown', (e) => {
  if (e.target.closest('input, textarea')) return;
  if (DRIVE_KEYS.has(e.code)) {
    e.preventDefault();
    keys.add(e.code);
    pushDrive();
    return;
  }
  if (e.repeat) return;
  switch (e.code) {
    case 'Space':
      e.preventDefault();
      api.command({ type: 'estop' });
      say('Emergency stop commanded.', 'hazard', 'Operator');
      break;
    case 'KeyX':
      api.command({ type: 'arm' });
      break;
    case 'KeyI':
      api.command({ type: 'image' });
      break;
    case 'KeyC':
      setCam(CAMS[(CAMS.indexOf(scene.cameraMode) + 1) % CAMS.length]);
      break;
    case 'KeyP':
      setSpeed(ui.speed === 0 ? 1 : 0);
      break;
    case 'KeyF':
      ui.showFov = !ui.showFov;
      break;
    case 'KeyH':
      setHelp($('#help').classList.contains('hidden'));
      break;
  }
});
window.addEventListener('keyup', (e) => {
  if (keys.delete(e.code)) pushDrive();
});
window.addEventListener('blur', () => {
  keys.clear();
  pushDrive();
});

// Click (not drag) on terrain → AutoNav waypoint.
const canvas = scene.renderer.domElement;
let down = null;
canvas.addEventListener('pointerdown', (e) => (down = { x: e.clientX, y: e.clientY }));
canvas.addEventListener('pointerup', (e) => {
  if (!down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 5 || e.button !== 0) return;
  const p = scene.pick(e.clientX, e.clientY);
  if (p) {
    api.command({ type: 'waypoint', x: p.x, z: p.z });
    say(`Waypoint set ${Math.hypot(p.x - rover.x, p.z - rover.z).toFixed(0)} m away. Navigation will plan a path with A*.`, 'nav');
  }
});

/* ───────────── HUD ───────────── */
const chips = $('#status-chips');
const hudGrid = $('#hud-grid');
const SOL0 = 1347;
function lmst(ms) {
  const solMs = 88775244;
  const t = 10 * 3600e3 * (solMs / 86400e3) + ms;
  const sol = SOL0 + Math.floor(t / solMs);
  const f = (t % solMs) / solMs;
  const h = Math.floor(f * 24);
  const m = Math.floor((f * 24 - h) * 60);
  const s = Math.floor(((f * 24 - h) * 60 - m) * 60);
  return `Sol ${sol}, ${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}
function updateHud() {
  const mode = sys.powerMode === 'safe' ? 'Safe mode' : sys.powerMode === 'low' ? `${sys.mode === 'autonav' ? 'AutoNav' : 'Manual'}, low power` : sys.mode === 'autonav' ? 'AutoNav' : 'Manual drive';
  const modeEl = $('#hud-mode');
  modeEl.textContent = mode;
  modeEl.className = `mode ${sys.powerMode !== 'nominal' ? sys.powerMode : sys.mode}`;
  const haz = $('#hud-haz');
  const stale = k.tick - sys.lastHazardScan > 400;
  haz.textContent = stale ? `Hazcam stale ${((k.tick - sys.lastHazardScan) / 1000).toFixed(1)} s` : sys.hazardAhead ? `Obstacle at ${sys.hazardDist.toFixed(1)} m` : 'Hazcam clear';
  haz.className = `haz ${stale ? 'stale' : sys.hazardAhead ? 'on' : ''}`;
  $('#hud-speed').textContent = Math.abs(rover.v).toFixed(2);
  const hdg = ((((-rover.yaw * 180) / Math.PI) % 360) + 360) % 360;
  hudGrid.innerHTML = [
    ['Heading', `${hdg.toFixed(0)}°`],
    ['Odometer', `${rover.odometer.toFixed(1)} m`],
    ['Pitch / roll', `${((rover.pitch * 180) / Math.PI).toFixed(1)}° / ${((rover.roll * 180) / Math.PI).toFixed(1)}°`],
    ['Position', `${rover.x.toFixed(1)}, ${rover.z.toFixed(1)}`],
    ['Power in / out', `${(sys.powerIn ?? 110).toFixed(0)} / ${(sys.powerOut ?? rover.powerDraw).toFixed(0)} W`],
    ['Air', `${sys.meda.temp.toFixed(1)} °C, ${sys.meda.pressure.toFixed(0)} Pa`],
    ['Downlinked', `${sys.downlinked} pkt, ${(sys.bytesDown / 1024).toFixed(1)} KiB`],
    ['Cores / images', `${sys.samples} / ${sys.images}`],
  ]
    .map(([a, b]) => `<span>${a}</span><b>${b}</b>`)
    .join('');
  const soc = $('#hud-soc');
  soc.style.transform = `scaleX(${sys.soc})`;
  soc.style.background = sys.soc < 0.15 ? 'var(--crit)' : sys.soc < 0.3 ? 'var(--warn)' : 'var(--text-2)';
  $('#hud-soc-t').textContent = `${(sys.soc * 100).toFixed(0)}%`;

  const cpu = k.cpuLoad;
  const heapFree = k.heap.freeBytes() / k.heap.size;
  const boosted = k.tasks.filter((t) => t.priority !== t.basePriority).map((t) => t.name);
  const cell = (label, val, cls = '') => `<div class="${cls}"><span>${label}</span><b>${val}</b></div>`;
  chips.innerHTML = [
    cell('Local mean solar time', lmst(k.tick)),
    cell('Kernel tick', k.tick.toLocaleString()),
    cell('CPU', `${(cpu * 100).toFixed(0)}%`, cpu > 0.95 ? 'crit' : cpu > 0.8 ? 'warn' : ''),
    cell('Heap free', `${(heapFree * 100).toFixed(0)}%`, heapFree < 0.15 ? 'crit' : ''),
    cell('Tasks', k.tasks.length),
    boosted.length ? cell('Inheriting priority', boosted.join(', '), 'warn') : '',
    ui.speed !== 1 ? cell('Sim speed', ui.speed === 0 ? 'Paused' : `${ui.speed}×`, 'warn') : '',
  ].join('');

  if (director.active) {
    const a = director.active;
    const bar = $('#scn-prog');
    if (bar) bar.style.transform = `scaleX(${Math.min(1, (k.tick - a.t0) / (a.until - a.t0))})`;
  }
}

/* ───────────── main loop ───────────── */
let last = performance.now();
let acc = 0;
let hudT = 0;
function frame(now) {
  const dtReal = Math.min(0.1, (now - last) / 1000);
  last = now;
  acc += dtReal * 1000 * ui.speed;
  let n = Math.floor(acc);
  acc -= n;
  n = Math.min(n, 250);
  for (let i = 0; i < n; i++) {
    k.step();
    director.update(k.tick);
    rover.update(0.001, k.tick);
  }
  for (const e of sys.events.splice(0)) say(e.text, e.kind);
  scene.update(dtReal * Math.max(ui.speed, 0.05), rover, sys, k, ui);
  dash.update(now);
  if (now - hudT > 100) {
    hudT = now;
    updateHud();
  }
  requestAnimationFrame(frame);
}

scene
  .loadRover('assets/perseverance.glb', (p) => {
    $('#loading-bar').style.transform = `scaleX(${p})`;
  })
  .catch((e) => {
    console.error(e);
    $('#loading-text').textContent = 'Could not load the rover model. Serve this folder over HTTP (npm start).';
  })
  .finally(() => {
    $('#loading').classList.add('done');
    say('All 10 tasks are running. Drive with W A S D, or click the terrain to send the rover somewhere on its own.', 'info');
  });

syncCfg();
renderScenario();
requestAnimationFrame(frame);

// Exposed for console exploration during the demo.
window.roverOS = { k, sys, rover, api, scene, director };
