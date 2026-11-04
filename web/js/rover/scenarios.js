/**
 * Scripted fault-injection scenarios for the demo. Each one shows an OS concept
 * from the course and can usually be run with the protection on or off.
 */

export const SCENARIOS = [
  {
    id: 'inversion',
    title: 'Priority inversion',
    concept: 'Mutex · priority inheritance · Mars Pathfinder 1997',
    blurb:
      'Comm (prio 1) holds the SensorBus during a long downlink. ImageCompress (prio 3) preempts it. HazardAvoid (prio 6) then waits on the bus while the rover drives toward a boulder.',
    fix: 'Priority inheritance',
    duration: 11000,
    run(ctx, fixOn) {
      const { sys, rover, api } = ctx;
      api.setPriorityInheritance(fixOn);
      ctx.save('loadShedding', sys.loadShedding);
      sys.loadShedding = false;
      ctx.resetRover(0, -2, 0);
      ctx.spawnRock(0, 13.5, 1.3);
      ctx.say(fixOn ? 'Priority inheritance is ON. Comm will be boosted when HazardAvoid blocks on the bus.' : 'Priority inheritance is OFF. Watch HazardAvoid in the timeline.');
      ctx.at(0, () => {
        sys.commBurst = true;
        api.k.raiseISR('UPLINK', (isr) => isr.sendFromISR(api.Q.telem, { kind: 'IMG-HIRES', bytes: 8192 }));
      });
      // As soon as Comm owns the bus, a medium-priority CPU hog starts.
      ctx.when(
        () => api.M.bus.owner?.name === 'Comm',
        () => {
          api.spawnHog();
          ctx.say('ImageCompress (prio 3) started while Comm holds the SensorBus.');
          ctx.after(60, () => api.command({ type: 'drive', throttle: 0.9, steer: 0 }));
        },
      );
      ctx.at(10500, () => api.command({ type: 'drive', throttle: 0, steer: 0 }));
    },
    cleanup(ctx) {
      ctx.api.killHog();
      ctx.restore('loadShedding');
      ctx.api.setPriorityInheritance(ctx.ui.inheritance);
    },
  },
  {
    id: 'deadlock',
    title: 'Deadlock',
    concept: 'Circular wait · lock ordering · wait-for graph',
    blurb:
      'ArmCtrl locks CameraMutex then PowerRail. Sensor locks PowerRail then CameraMutex. Each one ends up holding the lock the other needs.',
    fix: 'Lock ordering',
    duration: 9000,
    run(ctx, fixOn) {
      const { sys, api } = ctx;
      sys.deadlockBug = true;
      ctx.save('lockOrdering', sys.lockOrdering);
      sys.lockOrdering = fixOn;
      ctx.say(fixOn ? 'Lock ordering is enforced: every task takes PowerRail before CameraMutex.' : 'ArmCtrl takes the locks in the wrong order, which creates a circular wait.');
      ctx.at(0, () => {
        api.command({ type: 'arm' });
        api.command({ type: 'image' });
      });
    },
    cleanup(ctx) {
      ctx.sys.deadlockBug = false;
      ctx.restore('lockOrdering');
    },
  },
  {
    id: 'overload',
    title: 'CPU overload',
    concept: 'Preemptive scheduling · starvation · load shedding',
    blurb:
      'A runaway ImageCompress task (prio 3) takes ~99% of the CPU. Lower-priority Sensor and Comm starve, while higher-priority tasks keep their deadlines.',
    fix: 'Load shedding',
    duration: 12000,
    run(ctx, fixOn) {
      const { sys, api } = ctx;
      ctx.save('loadShedding', sys.loadShedding);
      sys.loadShedding = fixOn;
      api.spawnHog();
      ctx.say(fixOn ? 'Load shedding is ON. SelfMonitor will demote the hog after about 2 s at 95%+ CPU.' : 'Load shedding is OFF. Sensor and Comm starve and their deadline misses climb.');
    },
    cleanup(ctx) {
      ctx.api.killHog();
      ctx.restore('loadShedding');
    },
  },
  {
    id: 'hang',
    title: 'Task hang',
    concept: 'Software watchdog · task restart',
    blurb: 'Navigation enters an infinite loop and stops kicking the watchdog. SelfMonitor detects it and restarts the task.',
    duration: 6000,
    run(ctx) {
      ctx.sys.navHang = true;
      ctx.say('A bug sends Navigation into an endless loop at prio 3.');
    },
  },
  {
    id: 'stack',
    title: 'Stack overflow',
    concept: 'Stack high-water mark · overflow hook',
    blurb: 'Deep recursion in terrain segmentation overflows the 512-word Navigation stack. The overflow hook deletes the task and SelfMonitor restarts it with a bigger stack.',
    duration: 5000,
    run(ctx) {
      ctx.sys.stackBomb = true;
      ctx.say('Next segmentation pass recurses 40 levels deep (~1.5k words).');
    },
  },
  {
    id: 'leak',
    title: 'Memory leak',
    concept: 'heap_4 · fragmentation · malloc-failed hook',
    blurb: 'Comm stops freeing Mastcam image buffers. The heap fills up until pvPortMalloc fails, then the heap audit reclaims the orphaned buffers.',
    duration: 16000,
    run(ctx) {
      ctx.sys.leakBug = true;
      ctx.say('Comm now forgets vPortFree() after each image downlink. Watch the Memory tab.');
    },
    cleanup(ctx) {
      ctx.sys.leakBug = false;
    },
  },
  {
    id: 'power',
    title: 'Low power',
    concept: 'Dynamic task management · suspend/resume',
    blurb: 'The battery drops to 10%. Power suspends science and navigation tasks (SAFE mode), then resumes them as the MMRTG recharges the battery.',
    duration: 34000,
    run(ctx) {
      ctx.sys.soc = 0.1;
      ctx.sys.chargeBoost = 20;
      ctx.say('Battery at 10%. Power will step down through LOW to SAFE mode.');
    },
    cleanup(ctx) {
      ctx.sys.chargeBoost = 1;
    },
  },
];

/** Runs one scenario at a time on the kernel's clock. */
export class Director {
  constructor(ctxBase) {
    this.ctxBase = ctxBase;
    this.active = null;
    this.steps = [];
    this.saved = {};
    this.listeners = [];
  }

  onChange(fn) {
    this.listeners.push(fn);
  }
  emit() {
    for (const fn of this.listeners) fn(this.active);
  }

  start(scn, fixOn) {
    if (this.active) this.stop();
    const k = this.ctxBase.api.k;
    const t0 = k.tick;
    this.saved = {};
    const ctx = {
      ...this.ctxBase,
      at: (ms, fn) => this.steps.push({ at: t0 + ms, fn }),
      after: (ms, fn) => this.steps.push({ at: k.tick + ms, fn }),
      when: (pred, fn) => this.steps.push({ at: t0, pred, fn }),
      save: (key, v) => {
        this.saved[key] = v;
      },
      restore: (key) => {
        if (key in this.saved) this.ctxBase.sys[key] = this.saved[key];
      },
    };
    this.ctx = ctx;
    this.active = { scn, fixOn, t0, until: t0 + scn.duration };
    k.log('info', 'scenario', `▶ ${scn.title} (${scn.fix ? (fixOn ? scn.fix + ' ON' : scn.fix + ' OFF') : 'auto-recovery'})`);
    scn.run(ctx, fixOn);
    this.emit();
  }

  stop() {
    if (!this.active) return;
    const { scn } = this.active;
    this.steps = [];
    scn.cleanup?.(this.ctx);
    this.ctxBase.clearScripted();
    this.ctxBase.api.k.log('info', 'scenario', `■ ${scn.title} finished`);
    this.active = null;
    this.emit();
  }

  update(tick) {
    if (!this.active) return;
    const due = this.steps.filter((s) => s.at <= tick && (!s.pred || s.pred()));
    if (due.length) {
      this.steps = this.steps.filter((s) => !due.includes(s));
      for (const s of due) s.fn();
    }
    if (tick >= this.active.until) this.stop();
  }
}
