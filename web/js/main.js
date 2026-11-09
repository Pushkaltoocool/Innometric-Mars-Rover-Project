import { MarsScene } from './world/scene.js';
import { RoverSim } from './world/rover-sim.js';
import { rocks, addRock, rebuildGrid, stampRock } from './world/terrain.js';
import { createRoverSystem } from './rover/system.js';
import { SCENARIOS, Director } from './rover/scenarios.js';
import { Dashboard } from './ui/dashboard.js';

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

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

const scnList = $('#scn-list');
let selected = null;
function renderScenario() {
  const a = director.active;
  scnList.innerHTML = SCENARIOS.map((s) => {
    const open = selected === s;
    const running = a?.scn === s;
    let actions;
    if (running) actions = `<button data-act="stop">Stop</button>`;
    else if (s.fix) actions = `<button data-act="run" data-fix="0">Without ${esc(s.fix.toLowerCase())}</button><button class="primary" data-act="run" data-fix="1">With ${esc(s.fix.toLowerCase())}</button>`;
    else actions = `<button class="primary" data-act="run" data-fix="1">Run</button>`;
    return `<div class="scn${open ? ' open' : ''}${running ? ' running' : ''}"><button class="scn-h" data-toggle="${s.id}" aria-expanded="${open}"><b>${esc(s.title)}</b><small>${esc(s.concept)}</small></button>${open ? `<div class="scn-b"><p>${esc(s.blurb)}</p><div class="scn-a">${actions}</div></div>` : ''}</div>`;
  }).join('');
  $('#scn-live').hidden = !a;
  if (a) $('#scn-live-t').textContent = a.scn.title;
}
scnList.addEventListener('click', (e) => {
  const t = e.target.closest('[data-toggle]');
  if (t) {
    selected = selected?.id === t.dataset.toggle ? null : SCENARIOS.find((x) => x.id === t.dataset.toggle);
    return renderScenario();
  }
  const b = e.target.closest('button[data-act]');
  if (!b || !selected) return;
  if (b.dataset.act === 'stop') director.stop();
  else {
    director.start(selected, b.dataset.fix === '1');
    if (ui.speed === 0 && !ui.step) setSpeed(1);
  }
});
$('#scn-stop').addEventListener('click', () => director.stop());
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
  if (ui.step) exitStep(false);
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

/* ───────────── step mode ─────────────
 * Time stops. Each "Next event" runs kernel ticks until the kernel makes a
 * decision worth explaining (interrupt, queue message, context switch, lock,
 * priority change ...), then shows it in plain language. */
const stepper = $('#stepper');
const stList = $('#st-list');
const stNow = $('#st-now');
const PATH_OBJS = new Set(['CmdQueue', 'MotorQueue', 'CMD']);
/* Is this event part of an operator command's journey? Decided once, in order, as events arrive:
 * MainComputer's routine CmdQueue timeouts (every 250 ms) are not, a real command is. */
const pathState = { cmd: false };
function classifyPath(e) {
  if (e.kind === 'input' || e.kind === 'actuator' || e.kind === 'isr') return true;
  if (e.kind === 'wake') return false;
  if (e.obj === 'CmdQueue' && e.kind === 'send') return (pathState.cmd = true);
  if (e.kind === 'switch' && e.task === 'MainComputer') return pathState.cmd;
  if (e.kind === 'block' && e.obj === 'CmdQueue') {
    const was = pathState.cmd;
    pathState.cmd = false;
    return was;
  }
  return PATH_OBJS.has(e.obj);
}
const onPath = (e) => !!e.path;
const st = { filter: 'all', fresh: [], shown: [], batch: 0, auto: null, note: '' };

function enterStep() {
  if (ui.step) return;
  ui.step = true;
  ui.speed = 0;
  for (const b of document.querySelectorAll('[data-speed]')) b.setAttribute('aria-pressed', 'false');
  $('#step-open').setAttribute('aria-pressed', 'true');
  k.onEvent = (e) => {
    e.path = classifyPath(e);
    st.fresh.push(e);
  };
  keys.clear();
  stepper.classList.add("on");
  $('#tab-step').hidden = false;
  dash.setTab('step');
  document.body.classList.add('stepping');
  document.querySelector('[data-window="250"]')?.click();
  st.note = 'Press W to drive. The key press becomes an interrupt; step through it to watch the command travel through the OS.';
  renderStep();
}

function exitStep(resume = true) {
  if (!ui.step) return;
  ui.step = false;
  setAuto(false);
  k.onEvent = null;
  st.fresh.length = 0;
  stepper.classList.remove("on");
  document.body.classList.remove('stepping');
  $('#step-open').setAttribute('aria-pressed', 'false');
  $('#tab-step').hidden = true;
  dash.setTab('rover');
  // Drive keys latch in step mode; release them so the rover doesn't run off.
  keys.clear();
  lastDrive = 'step';
  pushDrive();
  if (resume) setSpeed(1);
}

/** One kernel tick plus everything that hangs off it (scenario script, physics). */
function tickOnce() {
  const s0 = rover.target.speed;
  const r0 = rover.target.steer;
  k.step();
  director.update(k.tick);
  rover.update(0.001, k.tick);
  if (ui.step && (rover.target.speed !== s0 || rover.target.steer !== r0)) {
    st.fresh.push({
      tick: k.tick, kind: 'actuator', path: true, concept: 'Hardware output', task: 'MotorCtrl',
      text: `The wheel motors get a new setpoint: ${rover.target.speed.toFixed(1)} m/s, steering ${rover.target.steer.toFixed(1)}. The rover starts to respond`,
    });
  }
}

function publish(events) {
  st.batch++;
  for (const e of events) st.shown.unshift({ ...e, batch: st.batch });
  st.shown.length = Math.min(st.shown.length, 60);
}

function stepEvent() {
  const want = st.filter === 'path' ? onPath : () => true;
  const limit = st.filter === 'path' ? 3000 : 1000;
  for (let i = 0; i < limit; i++) {
    tickOnce();
    const hit = st.fresh.filter(want);
    st.fresh.length = 0;
    if (hit.length) {
      publish(hit);
      st.note = '';
      return renderStep();
    }
  }
  st.note = st.filter === 'path'
    ? `Nothing on the command path for ${limit / 1000} s. Press a drive key (W A S D) or Space first.`
    : `Nothing happened for ${limit} ms.`;
  renderStep();
}

function stepTick() {
  tickOnce();
  const evs = st.fresh.splice(0);
  publish(evs.length ? evs : [{ tick: k.tick, kind: 'quiet', concept: 'Tick', text: k.current ? `${k.current.name} keeps the CPU for this 1 ms tick. Nothing else changed` : 'Nothing ran' }]);
  st.note = '';
  renderStep();
}

function setAuto(on) {
  clearInterval(st.auto);
  st.auto = on ? setInterval(stepEvent, 1100) : null;
  $('#st-auto').setAttribute('aria-pressed', String(on));
  $('#st-auto').textContent = on ? 'Stop auto-play' : 'Auto-play';
}

const TONE = { Preemption: 'warn', 'Priority inheritance': 'warn', 'Mutex contention': 'warn', Warning: 'warn', Fault: 'crit', 'Deadline miss': 'crit' };

function renderStep() {
  const cur = k.current;
  const waiting = [];
  for (let p = k.cfg.maxPriorities - 1; p >= 0; p--) {
    for (const t of k.ready[p]) if (t !== cur && !t.spec.idle) waiting.push(`${t.name} ${p}`);
  }
  const pend = k.isrPending.map((i) => i.name);
  stNow.innerHTML = [
    ['Tick', `${k.tick.toLocaleString()} <i>(1 tick = 1 ms)</i>`],
    ['On the CPU', cur ? `${cur.name} <i>priority ${cur.priority}${cur.priority !== cur.basePriority ? `, inherited from ${cur.basePriority}` : ''}</i>` : '–'],
    ['Ready, waiting', waiting.length ? waiting.join(', ') : '<i>none</i>'],
    ['Blocked', `${k.blocked.size} tasks`],
    pend.length ? ['Interrupt pending', `${pend.join(', ')} <i>runs at the start of the next tick</i>`] : null,
  ]
    .filter(Boolean)
    .map(([a, b]) => `<dt>${a}</dt><dd>${b}</dd>`)
    .join('');
  const items = st.shown.slice(0, 40).map((e) => {
    const cls = [e.batch === st.batch ? 'now' : '', TONE[e.concept] ?? '', onPath(e) ? 'path' : ''].join(' ');
    return `<li class="${cls}"><span class="t">${e.tick.toLocaleString()}</span><div><b>${esc(e.concept)}</b>${esc(e.text)}.</div></li>`;
  });
  stList.innerHTML = (st.note ? `<li class="hint">${esc(st.note)}</li>` : '') + items.join('');
}

$('#step-open').addEventListener('click', () => (ui.step ? exitStep() : enterStep()));
$('#st-exit').addEventListener('click', () => exitStep());
$('#st-start').addEventListener('click', () => enterStep());
$('#st-event').addEventListener('click', stepEvent);
$('#st-tick').addEventListener('click', stepTick);
$('#st-auto').addEventListener('click', () => setAuto(!st.auto));
for (const b of document.querySelectorAll('[data-stf]')) {
  b.addEventListener('click', () => {
    st.filter = b.dataset.stf;
    for (const x of document.querySelectorAll('[data-stf]')) x.setAttribute('aria-pressed', x === b);
  });
}

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
  if (ui.step) stepInput(`You send "drive ${throttle}, ${steer}". The keyboard raises interrupt CMD; nothing moves until the kernel handles it`);
}

/** In step mode, show the operator's input in the list straight away. */
function stepInput(text) {
  publish([{ tick: k.tick, kind: 'input', path: true, concept: 'Your input', text }]);
  st.note = 'Now press Next event. Choose "My command only" to skip the other tasks.';
  renderStep();
}
const DRIVE_KEYS = new Set(['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']);
window.addEventListener('keydown', (e) => {
  if (e.target.closest?.('input, textarea')) return;
  if (DRIVE_KEYS.has(e.code)) {
    e.preventDefault();
    if (ui.step) {
      // Keys latch in step mode: one press is one command, and releasing the key sends nothing.
      if (e.repeat) return;
      keys.clear();
    }
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
      if (ui.step) {
        keys.clear();
        lastDrive = '0,0';
        stepInput('You press emergency stop. The keyboard raises interrupt CMD with an "estop" command');
      }
      break;
    case 'KeyN':
      if (ui.step) stepEvent();
      else enterStep();
      break;
    case 'KeyT':
      if (ui.step) stepTick();
      break;
    case 'Escape':
      if (ui.step) exitStep();
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
      $('#haz-fov').setAttribute('aria-pressed', ui.showFov);
      break;
    case 'KeyH':
      setHelp($('#help').classList.contains('hidden'));
      break;
    case 'KeyB':
      setPanel(document.body.classList.contains('no-panel'));
      break;
  }
});
window.addEventListener('keyup', (e) => {
  if (keys.delete(e.code) && !ui.step) pushDrive();
});
window.addEventListener('blur', () => {
  keys.clear();
  if (!ui.step) pushDrive();
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
  const mode = sys.powerMode === 'safe' ? 'Safe mode' : sys.powerMode === 'low' ? `${sys.mode === 'autonav' ? 'AutoNav' : 'Manual'}, low power` : sys.mode === 'autonav' ? 'AutoNav' : 'Manual';
  const modeEl = $('#hud-mode');
  modeEl.textContent = mode;
  modeEl.className = `mode ${sys.powerMode !== 'nominal' ? sys.powerMode : sys.mode}`;
  const haz = $('#hud-haz');
  const stale = k.tick - sys.lastHazardScan > 400;
  const hazText = !sys.parts.hazAuto ? 'Auto-stop off' : stale ? `Hazcam stale ${((k.tick - sys.lastHazardScan) / 1000).toFixed(1)} s` : sys.hazardAhead ? `Obstacle ${sys.hazardDist.toFixed(1)} m` : 'Clear';
  haz.textContent = hazText;
  haz.className = `haz ${!sys.parts.hazAuto || stale ? 'stale' : sys.hazardAhead ? 'on' : ''}`;
  $('#p-haz-s').textContent = hazText;
  $('#hud-speed').textContent = Math.abs(rover.v).toFixed(2);

  // Part status lines and button states.
  $('#p-mast-s').textContent = k.tick - sys.mastBusy < 900 ? 'Imaging' : sys.parts.mastPan ? `Panned ${Math.round((sys.parts.mastPan * 180) / Math.PI)}°` : 'Centred';
  $('#p-arm-s').textContent = sys.armPhase ? { deploy: 'Moving to target', drill: 'Drilling', stow: 'Stowing' }[sys.armPhase] : sys.parts.armOut ? 'Deployed' : 'Stowed';
  $('#p-hga-s').textContent = k.tick - sys.hgaBusy < 400 ? 'Transmitting' : sys.parts.hgaOut ? 'Pointed at Earth' : 'Stowed';
  $('#p-whl-s').textContent = sys.speedLimit < 1 ? `Limited by ${sys.powerMode} power` : sys.parts.speedCap < 1 ? `${Math.round(sys.parts.speedCap * 100)}% cap` : 'Full power';
  $('#arm-toggle').textContent = sys.parts.armOut ? 'Stow' : 'Deploy';
  $('#hga-toggle').textContent = sys.parts.hgaOut ? 'Stow' : 'Point at Earth';
  const noPower = sys.powerMode !== 'nominal';
  for (const id of ['#arm-sample', '#mast-photo']) {
    $(id).disabled = noPower;
    $(id).title = noPower ? 'Suspended by the Power task to save energy' : '';
  }

  if (!$('[data-pane="rover"]').hidden) {
    const hdg = ((((-rover.yaw * 180) / Math.PI) % 360) + 360) % 360;
    hudGrid.innerHTML = [
      ['Local time', lmst(k.tick)],
      ['Heading', `${hdg.toFixed(0)}°`],
      ['Distance driven', `${rover.odometer.toFixed(1)} m`],
      ['Tilt (pitch, roll)', `${((rover.pitch * 180) / Math.PI).toFixed(1)}°, ${((rover.roll * 180) / Math.PI).toFixed(1)}°`],
      ['Power (in, out)', `${(sys.powerIn ?? 110).toFixed(0)} W, ${(sys.powerOut ?? rover.powerDraw).toFixed(0)} W`],
      ['Air', `${sys.meda.temp.toFixed(0)} °C, ${sys.meda.pressure.toFixed(0)} Pa`],
      ['Downlinked', `${sys.downlinked} packets, ${(sys.bytesDown / 1024).toFixed(1)} KiB`],
      ['Samples, photos', `${sys.samples}, ${sys.images}`],
    ]
      .map(([a, b]) => `<div><dt>${a}</dt><dd>${b}</dd></div>`)
      .join('');
  }
  const soc = $('#hud-soc');
  soc.style.transform = `scaleX(${sys.soc})`;
  soc.style.background = sys.soc < 0.15 ? 'var(--crit)' : sys.soc < 0.3 ? 'var(--warn)' : 'var(--text-2)';
  $('#hud-soc-t').textContent = `${(sys.soc * 100).toFixed(0)}%`;

  const cpu = k.cpuLoad;
  const heapFree = k.heap.freeBytes() / k.heap.size;
  const boosted = k.tasks.filter((t) => t.priority !== t.basePriority).map((t) => t.name);
  const cell = (label, val, cls = '') => `<div class="${cls}"><span>${label}</span><b>${val}</b></div>`;
  chips.innerHTML = [
    cell('CPU', `${(cpu * 100).toFixed(0)}%`, cpu > 0.95 ? 'crit' : cpu > 0.8 ? 'warn' : ''),
    heapFree < 0.25 ? cell('Heap free', `${(heapFree * 100).toFixed(0)}%`, heapFree < 0.15 ? 'crit' : 'warn') : '',
    boosted.length ? cell('Inheriting priority', boosted.join(', '), 'warn') : '',
    ui.step ? cell('Time', 'Stopped', 'warn') : '',
  ].join('');

  if (director.active) {
    const a = director.active;
    const bar = $('#scn-prog');
    if (bar) bar.style.transform = `scaleX(${Math.min(1, (k.tick - a.t0) / (a.until - a.t0))})`;
  }
}

/* ───────────── side panel: drag to resize, toggle to hide ───────────── */
const SIDE_DEFAULT = 460;
const store = (k, v) => { try { v === undefined ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch {} };
const load = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
function setSide(px) {
  const w = Math.round(Math.max(320, Math.min(px, window.innerWidth * 0.7)));
  document.documentElement.style.setProperty('--side', `${w}px`);
  store('roveros.side', w);
}
function setPanel(show) {
  document.body.classList.toggle('no-panel', !show);
  $('#panel-toggle').setAttribute('aria-pressed', show);
  store('roveros.panel', show ? '1' : '0');
}
if (load('roveros.side')) setSide(+load('roveros.side'));
if (load('roveros.panel') === '0') setPanel(false);
$('#panel-toggle').addEventListener('click', () => setPanel(document.body.classList.contains('no-panel')));
const grip = $('#panel-grip');
grip.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  grip.setPointerCapture(e.pointerId);
  document.body.classList.add('resizing');
  const move = (ev) => setSide(window.innerWidth - ev.clientX);
  const up = () => {
    document.body.classList.remove('resizing');
    grip.removeEventListener('pointermove', move);
    grip.removeEventListener('pointerup', up);
  };
  grip.addEventListener('pointermove', move);
  grip.addEventListener('pointerup', up);
});
grip.addEventListener('dblclick', () => setSide(SIDE_DEFAULT));
grip.addEventListener('keydown', (e) => {
  const cur = $('#panel').offsetWidth;
  if (e.key === 'ArrowLeft') setSide(cur + 20);
  else if (e.key === 'ArrowRight') setSide(cur - 20);
  else return;
  e.preventDefault();
  e.stopPropagation();
});

/* ───────────── part controls (each goes through CmdQueue like a keypress) ───────────── */
const part = (p, value) => api.command({ type: 'part', part: p, value });
const panEl = $('#mast-pan');
panEl.addEventListener('input', () => {
  $('#mast-pan-o').textContent = `${panEl.value}°`;
  part('mastPan', (+panEl.value * Math.PI) / 180);
});
$('#mast-ctr').addEventListener('click', () => {
  panEl.value = 0;
  panEl.dispatchEvent(new Event('input'));
});
$('#mast-photo').addEventListener('click', () => api.command({ type: 'image' }));
$('#arm-toggle').addEventListener('click', () => part('armOut', !sys.parts.armOut));
$('#arm-sample').addEventListener('click', () => api.command({ type: 'arm' }));
$('#hga-toggle').addEventListener('click', () => part('hgaOut', !sys.parts.hgaOut));
$('#hga-send').addEventListener('click', () => api.command({ type: 'downlink' }));
const capEl = $('#speed-cap');
capEl.addEventListener('input', () => {
  $('#speed-cap-o').textContent = `${capEl.value}%`;
  part('speedCap', +capEl.value / 100);
});
$('#whl-stop').addEventListener('click', () => api.command({ type: 'estop' }));
const hazBtn = $('#haz-avoid');
hazBtn.addEventListener('click', () => {
  const on = !sys.parts.hazAuto;
  part('hazAuto', on);
  hazBtn.setAttribute('aria-pressed', on);
  hazBtn.textContent = on ? 'Auto-stop on' : 'Auto-stop off';
  if (!on) say('Hazcam auto-stop is off. The rover will not brake for rocks.', 'hazard', 'Operator');
});
const fovBtn = $('#haz-fov');
fovBtn.addEventListener('click', () => {
  ui.showFov = !ui.showFov;
  fovBtn.setAttribute('aria-pressed', ui.showFov);
});

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
  for (let i = 0; i < n; i++) tickOnce();
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
