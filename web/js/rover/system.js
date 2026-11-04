/**
 * Perseverance flight software, rebuilt as a set of RoverOS tasks.
 *
 * Task map (Task 3 functional modules → RTOS tasks):
 *
 *   prio 7  SelfMonitor   watchdog, deadlock detection, fault recovery, heap audit, load shedding
 *   prio 6  HazardAvoid   hazcam scan over the shared SensorBus, emergency stop
 *   prio 5  MotorCtrl     Driver/Motor: applies drive commands to the wheels (50 Hz)
 *   prio 4  MainComputer  command dispatcher (keyboard ISR / uplink → tasks)
 *   prio 4  Power         MMRTG + battery model, dynamic suspend/resume of tasks
 *   prio 3  Navigation    route history, terrain segmentation, A* AutoNav, path following
 *   prio 2  Sensor        MEDA weather + Mastcam-Z imaging (PowerRail → Camera lock order)
 *   prio 2  ArmCtrl       robotic arm sampling (Camera + PowerRail)
 *   prio 1  Comm          telemetry downlink over the SensorBus, retry + exponential backoff
 *   prio 0  IDLE
 *
 * IPC: CmdQueue, MotorQueue, TelemetryQueue; mutexes SensorBus, CameraMutex, PowerRail;
 * binary semaphore ArmTrigger.
 */
import { Kernel, TaskState } from '../rtos/kernel.js';
import { planPath } from '../world/terrain.js';
import { ROVER } from '../world/rover-sim.js';

export const PRIO = { IDLE: 0, COMM: 1, SCIENCE: 2, NAV: 3, MAIN: 4, POWER: 4, MOTOR: 5, HAZARD: 6, MONITOR: 7 };

export const TASK_COLORS = {
  IDLE: '#4b5563',
  SelfMonitor: '#e879f9',
  HazardAvoid: '#f87171',
  MotorCtrl: '#fb923c',
  MainComputer: '#facc15',
  Power: '#a3e635',
  Navigation: '#34d399',
  Sensor: '#22d3ee',
  ArmCtrl: '#60a5fa',
  Comm: '#a78bfa',
  ImageCompress: '#f43f5e',
};

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const wrapAngle = (a) => Math.atan2(Math.sin(a), Math.cos(a));

export function createRoverSystem(rover) {
  const k = new Kernel();
  const Q = {
    cmd: k.createQueue('CmdQueue', 8),
    motor: k.createQueue('MotorQueue', 6),
    telem: k.createQueue('TelemetryQueue', 10),
  };
  const M = {
    bus: k.createMutex('SensorBus'),
    cam: k.createMutex('CameraMutex'),
    pwr: k.createMutex('PowerRail'),
  };
  const S = { arm: k.createSemaphore('ArmTrigger', 1, 0) };

  const sys = {
    mode: 'manual',
    waypoint: null,
    path: null,
    replan: false,
    cmdThrottle: 0,
    cmdSteer: 0,
    hazardAhead: false,
    hazardDir: 1,
    hazardDist: 12,
    hazardStops: 0,
    lastHazardScan: 0,
    powerMode: 'nominal',
    soc: 0.86,
    chargeBoost: 1,
    speedLimit: 1,
    downlinked: 0,
    bytesDown: 0,
    retries: 0,
    dropped: 0,
    leaked: 0,
    samples: 0,
    images: 0,
    imageRequest: false,
    armActive: false,
    armPhase: null,
    mastBusy: 0,
    hgaBusy: 0,
    meda: { temp: -63, pressure: 728, wind: 4.2 },
    // fault-injection switches (set by scenarios)
    commBurst: false,
    navHang: false,
    stackBomb: false,
    deadlockBug: false,
    leakBug: false,
    // protections (toggled from the UI)
    lockOrdering: true,
    loadShedding: true,
    pendingRestarts: [],
    events: [], // notable events for the UI narrator
  };

  const note = (kind, text) => {
    sys.events.push({ kind, text, tick: k.tick });
  };

  /* ─────────────────────── tasks ─────────────────────── */

  function* idleTask(os) {
    for (;;) yield os.run(1);
  }

  function* hazardTask(os) {
    for (;;) {
      yield os.delayUntil(50);
      os.kick();
      yield os.take(M.bus, Infinity);
      yield os.run(2); // read stereo hazcam frame over the bus
      const dir = sys.cmdThrottle < 0 ? -1 : 1;
      const d = rover.hazcamScan(dir);
      yield os.give(M.bus);
      yield os.run(1); // disparity / obstacle extraction
      const v = Math.abs(rover.v);
      const stopDist = (v * v) / (2 * ROVER.accel) + v * 0.15 + 0.9;
      const prev = sys.hazardAhead;
      sys.hazardDir = dir;
      sys.hazardDist = d;
      sys.hazardAhead = d < Math.max(1.2, stopDist);
      sys.lastHazardScan = os.now();
      if (sys.hazardAhead && !prev && sys.cmdThrottle !== 0) {
        sys.hazardStops++;
        os.log('warn', `Obstacle ${d.toFixed(1)} m ${dir > 0 ? 'ahead' : 'behind'} — E-STOP`);
        note('hazard', `HazardAvoid stopped the rover ${d.toFixed(1)} m from an obstacle.`);
        yield os.send(Q.motor, { type: 'estop' }, 0, true);
      }
    }
  }

  function* motorTask(os) {
    let thr = 0;
    let steer = 0;
    for (;;) {
      yield os.delayUntil(20);
      os.kick();
      let c;
      while ((c = yield os.recv(Q.motor, 0))) {
        if (c.type === 'estop') thr = 0;
        else if (c.type === 'drive') {
          thr = c.throttle;
          steer = c.steer;
        }
      }
      yield os.run(1); // motor current loop / wheel odometry
      let t = thr;
      if (sys.hazardAhead && t !== 0 && Math.sign(t) === sys.hazardDir) t = 0;
      rover.setActuators(t * ROVER.maxSpeed * sys.speedLimit, steer * (sys.speedLimit < 0.5 ? 0.6 : 1), os.now());
    }
  }

  function* mainTask(os) {
    for (;;) {
      const c = yield os.recv(Q.cmd, 250);
      os.kick();
      if (!c) continue;
      yield os.run(1); // validate + decode
      switch (c.type) {
        case 'drive': {
          if (sys.mode === 'autonav') {
            if (!c.throttle && !c.steer) break;
            sys.mode = 'manual';
            sys.path = null;
            sys.waypoint = null;
            os.log('info', 'Manual override — AutoNav cancelled');
          }
          sys.cmdThrottle = c.throttle;
          sys.cmdSteer = c.steer;
          const ok = yield os.send(Q.motor, { type: 'drive', throttle: c.throttle, steer: c.steer }, 20);
          if (!ok) os.log('warn', 'MotorQueue full — drive command dropped');
          break;
        }
        case 'waypoint':
          sys.mode = 'autonav';
          sys.waypoint = { x: c.x, z: c.z };
          sys.replan = true;
          os.log('info', `AutoNav goal (${c.x.toFixed(1)}, ${c.z.toFixed(1)})`);
          break;
        case 'arm':
          yield os.give(S.arm);
          break;
        case 'image':
          sys.imageRequest = true;
          break;
        case 'estop':
          sys.mode = 'manual';
          sys.path = null;
          sys.waypoint = null;
          sys.cmdThrottle = 0;
          sys.cmdSteer = 0;
          yield os.send(Q.motor, { type: 'drive', throttle: 0, steer: 0 }, 20, true);
          break;
      }
    }
  }

  function* navTask(os) {
    let cycle = 0;
    let blockedSince = 0;
    for (;;) {
      yield os.delayUntil(100);
      os.kick();
      cycle++;
      yield os.run(2); // visual odometry + route history

      if (sys.navHang) {
        sys.navHang = false;
        os.log('warn', 'Terrain mesh loop never terminates (bug) — no more watchdog kicks');
        for (;;) yield os.run(50);
      }

      // Recursive terrain segmentation (uses stack proportional to depth).
      if (cycle % 5 === 0) {
        let depth = 5 + (cycle % 4);
        if (sys.stackBomb) {
          sys.stackBomb = false;
          depth = 40;
          os.log('warn', 'Segmenting a large rock field: recursion depth 40');
        }
        for (let d = 1; d <= depth; d++) {
          os.stack(d * 36); // each recursion frame ≈ 36 words
          yield os.run(1);
        }
        os.stack(0);
      }

      if (sys.mode !== 'autonav' || !sys.waypoint) continue;

      if (sys.replan || !sys.path) {
        const buf = os.malloc(4096, 'A* open set');
        if (buf === null) {
          os.log('crit', 'Cannot plan: no heap for A* open set');
          continue;
        }
        const res = planPath(rover.x, rover.z, sys.waypoint.x, sys.waypoint.z);
        yield os.run(3 + res.expanded / 150); // planning cost scales with nodes expanded
        os.free(buf);
        sys.replan = false;
        if (!res.path) {
          os.log('warn', `No traversable path (${res.expanded} nodes expanded)`);
          sys.mode = 'manual';
          sys.waypoint = null;
          sys.cmdThrottle = 0;
          yield os.send(Q.motor, { type: 'drive', throttle: 0, steer: 0 }, 0);
          continue;
        }
        sys.path = res.path;
        sys.pathIdx = 0;
        os.log('info', `A* path: ${res.path.length} cells, ${res.expanded} expanded`);
      }

      const p = sys.path;
      const dGoal = Math.hypot(sys.waypoint.x - rover.x, sys.waypoint.z - rover.z);
      if (dGoal < 1.8) {
        os.log('info', 'Waypoint reached');
        note('nav', 'AutoNav reached the waypoint.');
        sys.mode = 'manual';
        sys.path = null;
        sys.waypoint = null;
        sys.cmdThrottle = 0;
        yield os.send(Q.motor, { type: 'drive', throttle: 0, steer: 0 }, 0);
        continue;
      }
      while (sys.pathIdx < p.length - 1 && Math.hypot(p[sys.pathIdx][0] - rover.x, p[sys.pathIdx][1] - rover.z) < 2.6) sys.pathIdx++;
      const look = p[Math.min(p.length - 1, sys.pathIdx + 1)];
      const want = Math.atan2(look[0] - rover.x, look[1] - rover.z);
      const err = wrapAngle(want - rover.yaw);
      let steer = clamp(err * 1.8, -1, 1);
      let thr = Math.abs(err) > 0.8 ? 0 : (dGoal < 5 ? 0.4 : 0.85) * (1 - Math.abs(err) * 0.6);
      if (sys.hazardAhead) {
        if (!blockedSince) blockedSince = os.now();
        if (os.now() - blockedSince > 1500) {
          thr = 0;
          steer = 1;
          sys.replan = true;
        }
      } else blockedSince = 0;
      sys.cmdThrottle = thr;
      sys.cmdSteer = steer;
      yield os.send(Q.motor, { type: 'drive', throttle: thr, steer }, 0);
    }
  }

  function* sensorTask(os) {
    let n = 0;
    for (;;) {
      yield os.delayUntil(500);
      os.kick();
      n++;
      const ok = yield os.take(M.bus, 400);
      if (!ok) {
        os.log('warn', 'SensorBus busy — MEDA sample skipped');
        continue;
      }
      yield os.run(3); // MEDA weather station read
      const m = sys.meda;
      m.temp = clamp(m.temp + (Math.random() - 0.5) * 0.6, -90, -20);
      m.pressure = clamp(m.pressure + (Math.random() - 0.5) * 2, 690, 760);
      m.wind = clamp(m.wind + (Math.random() - 0.5) * 0.8, 0, 14);
      yield os.give(M.bus);
      if (!(yield os.send(Q.telem, { kind: 'MEDA', bytes: 96 }, 0))) sys.dropped++;

      const want = sys.imageRequest || sys.leakBug || n % 6 === 0;
      if (want && sys.powerMode === 'nominal') {
        sys.imageRequest = false;
        // Canonical lock order: PowerRail → CameraMutex.
        yield os.take(M.pwr, Infinity);
        yield os.run(2); // power up camera heaters
        yield os.take(M.cam, Infinity);
        sys.mastBusy = os.now();
        yield os.run(8); // Mastcam-Z exposure + readout
        const ptr = os.malloc(3072, 'Mastcam image');
        yield os.give(M.cam);
        yield os.give(M.pwr);
        if (ptr !== null) {
          sys.images++;
          const sent = yield os.send(Q.telem, { kind: 'IMG', bytes: 3072, ptr }, 0);
          if (!sent) {
            os.free(ptr);
            sys.dropped++;
          }
        }
      }
    }
  }

  function* armTask(os) {
    sys.armActive = false;
    sys.armPhase = null;
    for (;;) {
      yield os.take(S.arm, Infinity);
      os.kick();
      sys.armActive = true;
      const wrong = sys.deadlockBug && !sys.lockOrdering;
      const first = wrong ? M.cam : M.pwr;
      const second = wrong ? M.pwr : M.cam;
      os.log('info', `Sampling sequence: lock ${first.name} then ${second.name}`);
      yield os.take(first, Infinity);
      os.kick();
      yield os.run(10);
      sys.armPhase = 'deploy';
      yield os.delay(800); // arm moving to target
      os.kick();
      yield os.take(second, Infinity);
      os.kick();
      sys.armPhase = 'drill';
      yield os.run(25);
      yield os.delay(900);
      os.kick();
      yield os.give(second);
      yield os.give(first);
      sys.samples++;
      sys.armPhase = 'stow';
      yield os.delay(600);
      sys.armActive = false;
      sys.armPhase = null;
      os.log('info', `Sample #${sys.samples} sealed`);
      yield os.send(Q.telem, { kind: 'SAMPLE', bytes: 256 }, 0);
    }
  }

  function* commTask(os) {
    for (;;) {
      const pkt = yield os.recv(Q.telem, 1000);
      os.kick();
      if (!pkt) continue;
      yield os.run(2); // CCSDS packetize + XOR scramble
      let sent = false;
      for (let attempt = 0; attempt < 4 && !sent; attempt++) {
        if (attempt > 0) {
          sys.retries++;
          yield os.delay(25 * 2 ** attempt); // exponential backoff
          os.kick();
        }
        if (!(yield os.take(M.bus, 2000))) continue;
        sys.hgaBusy = os.now();
        const txTicks = sys.commBurst ? 140 : 2 + Math.ceil(pkt.bytes / 512);
        if (sys.commBurst) {
          sys.commBurst = false;
          os.log('info', 'Long high-res downlink burst while holding SensorBus');
        }
        yield os.run(txTicks);
        yield os.give(M.bus);
        sent = Math.random() > 0.07;
      }
      if (sent) {
        sys.downlinked++;
        sys.bytesDown += pkt.bytes;
      } else {
        sys.dropped++;
        os.log('warn', `${pkt.kind} packet dropped after 4 attempts`);
      }
      if (pkt.ptr != null) {
        if (sys.leakBug) sys.leaked++;
        else os.free(pkt.ptr);
      }
    }
  }

  function* powerTask(os) {
    for (;;) {
      yield os.delayUntil(1000);
      os.kick();
      yield os.run(2);
      const load = rover.powerDraw + 18 * k.cpuLoad + (sys.armActive ? 40 : 0);
      const rtg = 110; // MMRTG electrical output, W
      const capWh = 2400;
      const accel = 120 * (rtg > load ? sys.chargeBoost : 1); // demo time compression
      sys.soc = clamp(sys.soc + ((rtg - load) / 3600 / capWh) * accel, 0.05, 1);
      sys.powerIn = rtg;
      sys.powerOut = load;
      let next = sys.powerMode;
      if (sys.powerMode === 'nominal' && sys.soc < 0.3) next = 'low';
      if (sys.powerMode === 'low' && sys.soc < 0.15) next = 'safe';
      if (sys.powerMode === 'low' && sys.soc > 0.4) next = 'nominal';
      if (sys.powerMode === 'safe' && sys.soc > 0.22) next = 'low';
      if (next !== sys.powerMode) applyPowerMode(os, next);
    }
  }

  function applyPowerMode(os, mode) {
    os.log(mode === 'nominal' ? 'info' : 'warn', `Power mode ${sys.powerMode.toUpperCase()} → ${mode.toUpperCase()} (SoC ${(sys.soc * 100).toFixed(0)}%)`);
    note('power', `Power mode is now ${mode.toUpperCase()}.`);
    sys.powerMode = mode;
    const sensor = k.getTask('Sensor');
    const arm = k.getTask('ArmCtrl');
    const nav = k.getTask('Navigation');
    if (mode === 'nominal') {
      sys.speedLimit = 1;
      sys.chargeBoost = 1;
      for (const t of [sensor, arm, nav]) k.resume(t);
    } else if (mode === 'low') {
      sys.speedLimit = 0.5;
      k.suspend(arm);
      k.resume(sensor);
      k.resume(nav);
    } else {
      sys.speedLimit = 0.25;
      sys.mode = 'manual';
      sys.path = null;
      sys.waypoint = null;
      for (const t of [sensor, arm, nav]) k.suspend(t);
    }
  }

  function* monitorTask(os) {
    let deadlockSince = 0;
    let overload = 0;
    const flagged = new Map();
    for (;;) {
      yield os.delayUntil(250);
      os.kick();
      yield os.run(2);
      const now = os.now();

      // 1. Deadlock detection on the wait-for graph.
      const cycle = k.findDeadlock();
      if (cycle) {
        if (!deadlockSince) {
          deadlockSince = now;
          const desc = cycle.map((t) => `${t.name} waits ${t.blockedOn.name} (held by ${t.blockedOn.owner.name})`).join('; ');
          os.log('crit', `DEADLOCK detected: ${desc}`);
          note('deadlock', `Deadlock: ${cycle.map((t) => t.name).join(' ⇄ ')}. Circular wait on ${cycle.map((t) => t.blockedOn.name).join(' / ')}.`);
        } else if (now - deadlockSince > 700) {
          const victim = [...cycle].sort((a, b) => a.priority - b.priority || (b.spec.victimPref ?? 0) - (a.spec.victimPref ?? 0))[0];
          os.log('crit', `Deadlock recovery: restarting ${victim.name} to break the cycle`);
          note('recover', `SelfMonitor broke the deadlock by restarting ${victim.name} (its locks were released).`);
          k.restartTask(victim.name);
          deadlockSince = 0;
        }
      } else deadlockSince = 0;

      // 2. Software watchdog.
      for (const t of [...k.tasks]) {
        const wd = t.spec.watchdogMs;
        if (!wd || t.state === TaskState.SUSPENDED) continue;
        if (t.spec.wdActive && !t.spec.wdActive()) {
          t.lastKick = now;
          continue;
        }
        const late = now - t.lastKick;
        if (late < wd) {
          flagged.delete(t.name);
          continue;
        }
        const f = flagged.get(t.name) ?? {};
        flagged.set(t.name, f);
        if (t.state === TaskState.BLOCKED && t.blockedOn?.kind === 'mutex') {
          const m = t.blockedOn;
          const owner = m.owner;
          if (owner && owner.priority < t.priority && owner.state !== TaskState.BLOCKED) {
            if (!f.inversion) {
              f.inversion = true;
              const running = k.tasks.filter((x) => x.priority > owner.priority && x.priority < t.priority && x.cpu > 0.2).map((x) => x.name);
              os.log('crit', `PRIORITY INVERSION: ${t.name}(${t.priority}) blocked on ${m.name} held by ${owner.name}(${owner.priority})${running.length ? `, which is preempted by ${running.join(', ')}` : ''}`);
              note('inversion', `Priority inversion: ${t.name} (prio ${t.priority}) is stuck behind ${owner.name} (prio ${owner.priority}), which can't run because ${running.join(', ') || 'medium-priority work'} is using the CPU.`);
            }
            if (late > 8000) {
              os.log('crit', `Watchdog reset of ${owner.name} to free ${m.name} (Pathfinder-style recovery)`);
              note('recover', `Watchdog reset ${owner.name} to release ${m.name}, which is how Mars Pathfinder kept rebooting in 1997.`);
              k.restartTask(owner.name);
            }
          }
          continue; // deadlocks are handled above
        }
        if ((t.state === TaskState.READY || t.state === TaskState.RUNNING) && t.cpu > 0.3) {
          os.log('crit', `Watchdog: ${t.name} not responding for ${late} ms while using ${(t.cpu * 100).toFixed(0)}% CPU — restarting`);
          note('recover', `Watchdog restarted ${t.name}, which was stuck in a loop.`);
          k.restartTask(t.name);
          continue;
        }
        if (!f.starved && t.state === TaskState.READY) {
          f.starved = true;
          os.log('warn', `${t.name} starved: ready but not scheduled for ${late} ms`);
        }
      }

      // 3. Restart tasks killed by the stack-overflow hook, with a bigger stack.
      for (const r of sys.pendingRestarts.splice(0)) {
        const words = Math.round((r.stackWords * 1.5) / 32) * 32;
        os.log('warn', `Restarting ${r.name} with stack ${r.stackWords}→${words} words`);
        note('recover', `${r.name} was restarted with a bigger stack (${r.stackWords} → ${words} words).`);
        k.restartTask(r.name, { stackWords: words });
      }

      // 4. Heap audit: reclaim image buffers nobody references any more.
      const h = k.heap;
      if (h.freeBytes() / h.size < 0.12) {
        const live = new Set(Q.telem.items.map((p) => p.ptr).filter((p) => p != null));
        let n = 0;
        for (const b of [...h.blocks]) {
          if (!b.free && b.tag === 'Mastcam image' && !live.has(b.addr)) {
            h.free(b.addr);
            n++;
          }
        }
        if (n) {
          os.log('warn', `Heap audit reclaimed ${n} leaked image buffers (${n * 3080} B)`);
          note('recover', `Heap audit freed ${n} leaked image buffers.`);
        }
      }

      // 5. Load shedding when the CPU is saturated.
      overload = k.cpuLoad > 0.95 ? overload + 1 : 0;
      if (sys.loadShedding && overload >= 8) {
        const hog = k.tasks.filter((t) => !t.spec.critical && !t.spec.idle && t.basePriority > 1).sort((a, b) => b.cpu - a.cpu)[0];
        if (hog && hog.cpu > 0.5) {
          os.log('warn', `CPU ${(k.cpuLoad * 100).toFixed(0)}% — load shedding: ${hog.name} priority ${hog.basePriority}→1`);
          note('recover', `Load shedding moved ${hog.name} down to priority 1, so the starved tasks can run again.`);
          k.setBasePriority(hog, 1);
        }
        overload = 0;
      }
    }
  }

  /* ─────────────────────── task table ─────────────────────── */

  const specs = [
    { name: 'IDLE', fn: idleTask, priority: PRIO.IDLE, stackWords: 128, idle: true, critical: true },
    { name: 'SelfMonitor', fn: monitorTask, priority: PRIO.MONITOR, stackWords: 384, critical: true, desc: 'Watchdog, deadlock detection, recovery' },
    { name: 'HazardAvoid', fn: hazardTask, priority: PRIO.HAZARD, stackWords: 256, watchdogMs: 400, critical: true, desc: 'Hazcam obstacle detection, E-stop' },
    { name: 'MotorCtrl', fn: motorTask, priority: PRIO.MOTOR, stackWords: 256, watchdogMs: 300, critical: true, desc: 'Wheel/steering actuation @50 Hz' },
    { name: 'MainComputer', fn: mainTask, priority: PRIO.MAIN, stackWords: 256, watchdogMs: 1000, critical: true, desc: 'Command dispatch' },
    { name: 'Power', fn: powerTask, priority: PRIO.POWER, stackWords: 256, watchdogMs: 3000, critical: true, desc: 'MMRTG/battery, power modes' },
    { name: 'Navigation', fn: navTask, priority: PRIO.NAV, stackWords: 512, watchdogMs: 1500, desc: 'Route history, A* AutoNav' },
    { name: 'Sensor', fn: sensorTask, priority: PRIO.SCIENCE, stackWords: 384, watchdogMs: 3000, victimPref: 0, desc: 'MEDA weather, Mastcam-Z' },
    { name: 'ArmCtrl', fn: armTask, priority: PRIO.SCIENCE, stackWords: 384, watchdogMs: 3000, wdActive: () => sys.armActive, victimPref: 1, desc: 'Robotic arm sampling' },
    { name: 'Comm', fn: commTask, priority: PRIO.COMM, stackWords: 384, watchdogMs: 4000, desc: 'Telemetry downlink, retry/backoff' },
  ];
  for (const s of specs) {
    s.color = TASK_COLORS[s.name];
    k.createTask(s);
  }

  k.hooks.stackOverflow = (t) => {
    sys.pendingRestarts.push({ name: t.name, stackWords: t.stackWords });
    note('fault', `Stack overflow in ${t.name}: it used more than its ${t.stackWords}-word stack. The kernel hook deleted the task.`);
  };
  k.hooks.mallocFailed = (who, bytes) => {
    note('fault', `pvPortMalloc(${bytes}) failed in ${who}. The heap is exhausted.`);
  };

  /* ─────────────────────── external interface ─────────────────────── */

  const hogSpec = {
    name: 'ImageCompress',
    priority: PRIO.NAV,
    stackWords: 256,
    color: TASK_COLORS.ImageCompress,
    desc: 'ICER wavelet compression (CPU hog)',
    fn: function* (os) {
      for (;;) {
        yield os.run(1000);
        yield os.delay(5);
      }
    },
  };

  return {
    k,
    Q,
    M,
    S,
    sys,
    specs,
    /** Keyboard / UI → CPU interrupt → CmdQueue (deferred processing in MainComputer). */
    command(cmd) {
      k.raiseISR('CMD', (isr) => {
        if (!isr.sendFromISR(Q.cmd, cmd)) k.log('warn', 'isr', `CmdQueue full — ${cmd.type} dropped`);
      });
    },
    spawnHog() {
      if (!k.getTask('ImageCompress')) k.createTask({ ...hogSpec });
    },
    killHog() {
      const t = k.getTask('ImageCompress');
      if (t) k.deleteTask(t, 'scenario end');
    },
    setPriorityInheritance(on) {
      k.cfg.priorityInheritance = on;
      for (const t of k.tasks) k._recalcPriority(t);
    },
  };
}
