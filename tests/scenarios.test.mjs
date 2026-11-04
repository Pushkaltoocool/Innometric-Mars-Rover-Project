// Headless verification of the RTOS kernel + rover scenarios.
// Run: node tests/scenarios.test.mjs
import { Kernel } from '../web/js/rtos/kernel.js';
import { RoverSim } from '../web/js/world/rover-sim.js';
import { rocks, addRock } from '../web/js/world/terrain.js';
import { createRoverSystem } from '../web/js/rover/system.js';
import { SCENARIOS, Director } from '../web/js/rover/scenarios.js';

let failures = 0;
const check = (cond, msg) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`);
  if (!cond) failures++;
};

/* ---------- kernel unit tests ---------- */
{
  // Preemption: a high-priority task becoming ready preempts a low one mid-burst.
  const k = new Kernel();
  const order = [];
  k.createTask({ name: 'IDLE', priority: 0, stackWords: 64, idle: true, fn: function* (os) { for (;;) yield os.run(1); } });
  k.createTask({ name: 'Low', priority: 1, stackWords: 64, fn: function* (os) { yield os.run(10); order.push('low-done@' + os.now()); for (;;) yield os.delay(1000); } });
  k.createTask({ name: 'High', priority: 3, stackWords: 64, fn: function* (os) { yield os.delay(3); yield os.run(4); order.push('high-done@' + os.now()); for (;;) yield os.delay(1000); } });
  for (let i = 0; i < 30; i++) k.step();
  check(order[0].startsWith('high-done') && order[1] === 'low-done@15', `preemption order ${order.join(', ')}`);
}
{
  // Queue blocking + timeout.
  const k = new Kernel();
  const q = k.createQueue('Q', 2);
  let got = [];
  k.createTask({ name: 'IDLE', priority: 0, stackWords: 64, idle: true, fn: function* (os) { for (;;) yield os.run(1); } });
  k.createTask({ name: 'Rx', priority: 2, stackWords: 64, fn: function* (os) { for (;;) got.push(yield os.recv(q, 50)); } });
  k.createTask({ name: 'Tx', priority: 1, stackWords: 64, fn: function* (os) { yield os.delay(10); yield os.send(q, 'a'); yield os.delay(100); } });
  for (let i = 0; i < 70; i++) k.step();
  check(got[0] === 'a' && got[1] === null, `queue receive then timeout → ${JSON.stringify(got)}`);
}
{
  // Deadlock detection.
  const k = new Kernel();
  const A = k.createMutex('A');
  const B = k.createMutex('B');
  k.createTask({ name: 'IDLE', priority: 0, stackWords: 64, idle: true, fn: function* (os) { for (;;) yield os.run(1); } });
  k.createTask({ name: 'T1', priority: 2, stackWords: 64, fn: function* (os) { yield os.take(A); yield os.delay(5); yield os.take(B); } });
  k.createTask({ name: 'T2', priority: 2, stackWords: 64, fn: function* (os) { yield os.take(B); yield os.delay(5); yield os.take(A); } });
  for (let i = 0; i < 20; i++) k.step();
  const cyc = k.findDeadlock();
  check(cyc && cyc.length === 2, `deadlock cycle found: ${cyc?.map((t) => t.name).join(' -> ')}`);
}
{
  // Heap coalescing.
  const k = new Kernel({ heapBytes: 1024 });
  const free0 = k.heap.freeBytes();
  const a = k.heap.malloc(100, 'x', 't');
  const b = k.heap.malloc(100, 'x', 't');
  k.heap.free(a);
  k.heap.free(b);
  check(k.heap.freeBytes() === free0 && k.heap.blocks.length === 1, 'heap_4 frees coalesce back into one block');
}

/* ---------- full-system scenarios ---------- */
function runScenario(id, fixOn, ms) {
  const rover = new RoverSim();
  const api = createRoverSystem(rover);
  const scripted = [];
  const ctx = {
    api,
    sys: api.sys,
    rover,
    ui: { inheritance: true },
    say: () => {},
    resetRover(x, z, yaw) {
      Object.assign(rover, { x, z, yaw, v: 0 });
      rover.target.speed = 0;
    },
    spawnRock(x, z, r) {
      scripted.push(addRock(x, z, r, true));
    },
    clearScripted() {
      for (const r of scripted) rocks.splice(rocks.indexOf(r), 1);
      scripted.length = 0;
    },
  };
  const d = new Director(ctx);
  let crashed = false;
  rover.on('collision', () => (crashed = true));
  for (let i = 0; i < 1500; i++) {
    api.k.step();
    rover.update(0.001, api.k.tick);
  }
  d.start(SCENARIOS.find((s) => s.id === id), fixOn);
  for (let i = 0; i < ms; i++) {
    api.k.step();
    d.update(api.k.tick);
    rover.update(0.001, api.k.tick);
  }
  d.stop();
  return { api, rover, crashed, logs: api.k.logs };
}

{
  const r = runScenario('inversion', false, 10000);
  check(r.crashed, 'priority inversion WITHOUT inheritance → rover hits the boulder');
  check(r.logs.some((l) => l.msg.includes('PRIORITY INVERSION')), 'SelfMonitor reports the inversion');
}
{
  const r = runScenario('inversion', true, 10000);
  check(!r.crashed && r.api.sys.hazardStops > 0, `priority inversion WITH inheritance → hazard stop, no crash (stops=${r.api.sys.hazardStops})`);
  check(r.logs.some((l) => l.msg.startsWith('Priority inheritance')), 'kernel logged inheritance boost');
}
{
  const r = runScenario('deadlock', false, 8000);
  check(r.logs.some((l) => l.msg.includes('DEADLOCK detected')), 'deadlock WITHOUT lock ordering is detected');
  check(r.logs.some((l) => l.msg.includes('Deadlock recovery')), 'deadlock recovered by task restart');
}
{
  const r = runScenario('deadlock', true, 8000);
  check(!r.logs.some((l) => l.msg.includes('DEADLOCK')) && r.api.sys.samples >= 1, `deadlock WITH lock ordering: none, samples=${r.api.sys.samples}`);
}
{
  const r = runScenario('hang', false, 5000);
  check(r.logs.some((l) => l.msg.includes('Watchdog: Navigation')), 'watchdog restarts hung Navigation');
}
{
  const r = runScenario('stack', false, 4000);
  check(r.logs.some((l) => l.msg.includes('StackOverflowHook')), 'stack overflow hook fires');
  check(r.api.k.getTask('Navigation')?.stackWords === 768, 'Navigation restarted with a 768-word stack');
}
{
  const r = runScenario('leak', false, 15000);
  check(r.logs.some((l) => l.msg.includes('Heap audit reclaimed')), 'heap audit reclaims leaked buffers');
}
{
  const r = runScenario('overload', true, 6000);
  check(r.logs.some((l) => l.msg.includes('load shedding')), 'load shedding demotes the hog');
}
{
  const r = runScenario('power', false, 4000);
  check(r.logs.some((l) => l.msg.includes('→ SAFE')) && r.api.k.getTask('Sensor').state === 'Suspended', `low power → SAFE mode, Sensor suspended (mode ${r.api.sys.powerMode})`);
}

console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
