/**
 * RoverOS — a FreeRTOS-semantics kernel simulator.
 *
 * Modelled on the FreeRTOS kernel (tasks.c / queue.c / heap_4.c):
 *  - Fixed-priority preemptive scheduling with round-robin time slicing between
 *    tasks of equal priority (configUSE_PREEMPTION / configUSE_TIME_SLICING).
 *    A cooperative mode can be selected for comparison.
 *  - Task states: Running, Ready, Blocked, Suspended, Deleted.
 *  - 1 tick = 1 ms (configTICK_RATE_HZ = 1000).
 *  - Queues with blocking send/receive and timeouts (xQueueSend / xQueueReceive),
 *    waiters ordered by priority, ISR-safe variants (xQueueSendFromISR).
 *  - Mutexes with optional priority inheritance, binary/counting semaphores.
 *  - vTaskDelay / vTaskDelayUntil with deadline-miss detection.
 *  - heap_4 style first-fit allocator with coalescing; TCB + stack are allocated
 *    from the heap on xTaskCreate, exactly like dynamic allocation in FreeRTOS.
 *  - Stack high-water marks and stack overflow detection
 *    (configCHECK_FOR_STACK_OVERFLOW) with an overflow hook.
 *  - Run-time statistics (CPU usage per task), context switch counting,
 *    wait-for graph + cycle detection for deadlock analysis.
 *
 * Tasks are JavaScript generator functions. Every kernel API call that can
 * block or reschedule is `yield`ed to the kernel, so preemption can happen at
 * any API call or at any tick of a CPU burst (`yield os.run(n)`).
 */

import { Heap } from './heap.js';

export const TaskState = Object.freeze({
  READY: 'Ready',
  RUNNING: 'Running',
  BLOCKED: 'Blocked',
  SUSPENDED: 'Suspended',
  DELETED: 'Deleted',
});

/** Numeric codes used in the per-tick state trace (Gantt chart). */
export const TraceState = Object.freeze({ NONE: 0, READY: 1, RUNNING: 2, BLOCKED: 3, SUSPENDED: 4, RUNNING_BOOSTED: 5 });

export class StackOverflowError extends Error {
  constructor(task, used) {
    super(`Stack overflow in ${task.name}: ${used} words used of ${task.stackWords}`);
    this.used = used;
  }
}

const TCB_BYTES = 96;
const MAX_ROWS = 16;

export class Kernel {
  constructor(cfg = {}) {
    this.cfg = Object.assign(
      {
        maxPriorities: 8,
        preemptive: true,
        timeSlicing: true,
        priorityInheritance: true,
        heapBytes: 48 * 1024,
        traceLen: 6000,
        statsWindow: 1000,
      },
      cfg,
    );
    this.tick = 0;
    this.tasks = [];
    this.ready = Array.from({ length: this.cfg.maxPriorities }, () => []);
    this.blocked = new Set();
    this.current = null;
    this.queues = [];
    this.mutexes = [];
    this.semaphores = [];
    this.isrPending = [];
    this.heap = new Heap(this.cfg.heapBytes);
    this.rows = new Map(); // task name -> gantt row
    this.rowNames = [];
    this.trace = new Int8Array(this.cfg.traceLen).fill(-1);
    this.traceIsr = new Uint8Array(this.cfg.traceLen);
    this.stateTrace = new Uint8Array(this.cfg.traceLen * MAX_ROWS);
    this.contextSwitches = 0;
    this.cpuLoad = 0;
    this.isrCount = 0;
    this.logs = [];
    this.logSeq = 0;
    this.listeners = new Set();
    this.hooks = { stackOverflow: null, mallocFailed: null, taskDeleted: null };
    this.specs = new Map(); // name -> creation spec, for restart
    this._nextId = 1;
  }

  /* ───────────────────────── logging ───────────────────────── */

  log(level, src, msg) {
    const e = { seq: ++this.logSeq, tick: this.tick, level, src, msg };
    this.logs.push(e);
    if (this.logs.length > 600) this.logs.splice(0, this.logs.length - 600);
    for (const l of this.listeners) l(e);
    return e;
  }

  onLog(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /* ───────────────────────── task management ───────────────────────── */

  /**
   * xTaskCreate equivalent.
   * spec: { name, fn, priority, stackWords, watchdogMs?, color?, critical?, params? }
   */
  createTask(spec) {
    const bytes = TCB_BYTES + spec.stackWords * 4;
    const mem = this.heap.malloc(bytes, spec.name, 'TCB+stack');
    if (mem === null) {
      this.log('crit', 'kernel', `xTaskCreate(${spec.name}) failed: heap exhausted (${bytes} B needed)`);
      this.hooks.mallocFailed?.(spec.name, bytes);
      return null;
    }
    if (!this.rows.has(spec.name)) {
      if (this.rowNames.length >= MAX_ROWS) throw new Error('Too many task rows');
      this.rows.set(spec.name, this.rowNames.length);
      this.rowNames.push(spec.name);
    }
    this.specs.set(spec.name, spec);
    const t = {
      id: this._nextId++,
      name: spec.name,
      spec,
      row: this.rows.get(spec.name),
      priority: spec.priority,
      basePriority: spec.priority,
      state: TaskState.READY,
      gen: null,
      runLeft: 0,
      pendingValue: undefined,
      wakeTick: Infinity,
      blockKind: null,
      blockedOn: null,
      blockedSince: 0,
      held: [],
      stackWords: spec.stackWords,
      stackBase: spec.baseStack ?? 48,
      stackCur: 0,
      stackPeak: 0,
      mem,
      runTicks: 0,
      win: 0,
      cpu: 0,
      lastKick: this.tick,
      lastWake: this.tick,
      jobs: 0,
      missed: 0,
      created: this.tick,
      restarts: spec._restarts ?? 0,
      sendItem: undefined,
      sendFront: false,
      fault: null,
      local: {}, // per-task scratch storage (persisted across restart? no)
    };
    t.stackCur = t.stackBase;
    t.stackPeak = t.stackBase;
    t.gen = spec.fn(this._api(t), t, spec.params);
    this.tasks.push(t);
    this._readyAdd(t);
    this.log('info', 'kernel', `xTaskCreate ${spec.name} prio=${spec.priority} stack=${spec.stackWords}w`);
    return t;
  }

  getTask(name) {
    return this.tasks.find((t) => t.name === name) ?? null;
  }

  /** vTaskDelete. Held mutexes are force-released so the system can recover. */
  deleteTask(t, reason = 'deleted') {
    if (!t || t.state === TaskState.DELETED) return;
    this._removeFromWaitLists(t);
    this._readyRemove(t);
    this.blocked.delete(t);
    for (const m of [...t.held]) {
      this.log('warn', 'kernel', `${m.name} force-released (owner ${t.name} ${reason})`);
      this._mutexRelease(m, t);
    }
    this.heap.free(t.mem);
    t.state = TaskState.DELETED;
    this.tasks = this.tasks.filter((x) => x !== t);
    if (this.current === t) this.current = null;
    this.hooks.taskDeleted?.(t, reason);
  }

  /** Delete and recreate a task from its original spec (watchdog recovery). */
  restartTask(name, overrides = {}) {
    const old = this.getTask(name);
    const spec = Object.assign({}, this.specs.get(name), overrides);
    if (!spec.fn) return null;
    spec._restarts = (old?.restarts ?? this.specs.get(name)?._restarts ?? 0) + 1;
    if (old) this.deleteTask(old, 'restarted');
    return this.createTask(spec);
  }

  suspend(t) {
    if (!t || t.state === TaskState.SUSPENDED || t.state === TaskState.DELETED) return;
    if (t.state === TaskState.BLOCKED) {
      // Abort the pending wait: return its timeout value when resumed.
      t.pendingValue = this._timeoutValue(t);
      this._removeFromWaitLists(t);
      this.blocked.delete(t);
      t.blockKind = null;
      t.blockedOn = null;
    }
    this._readyRemove(t);
    t.state = TaskState.SUSPENDED;
    this.log('info', 'kernel', `vTaskSuspend ${t.name}`);
  }

  resume(t) {
    if (!t || t.state !== TaskState.SUSPENDED) return;
    t.state = TaskState.READY;
    t.lastKick = this.tick;
    t.lastWake = this.tick;
    this._readyAdd(t);
    this.log('info', 'kernel', `vTaskResume ${t.name}`);
  }

  /** vTaskPrioritySet (changes base priority; inheritance is re-evaluated). */
  setBasePriority(t, p) {
    t.basePriority = p;
    this._recalcPriority(t);
  }

  /* ───────────────────────── IPC objects ───────────────────────── */

  createQueue(name, capacity) {
    const q = { kind: 'queue', name, capacity, items: [], recvWaiters: [], sendWaiters: [], hwm: 0, sent: 0, drops: 0 };
    this.queues.push(q);
    return q;
  }

  createMutex(name) {
    const m = { kind: 'mutex', name, owner: null, waiters: [], takes: 0, contentions: 0, heldSince: 0 };
    this.mutexes.push(m);
    return m;
  }

  createSemaphore(name, max = 1, initial = 0) {
    const s = { kind: 'semaphore', name, max, count: initial, waiters: [], gives: 0 };
    this.semaphores.push(s);
    return s;
  }

  /* ───────────────────────── interrupts ───────────────────────── */

  /** Queue an interrupt; its handler runs at the start of the next tick. */
  raiseISR(name, handler) {
    this.isrPending.push({ name, handler, raisedAt: this.tick });
  }

  _isrApi() {
    return {
      sendFromISR: (q, item, front = false) => this._queueSendNonBlocking(q, item, front),
      giveFromISR: (s) => this._semGive(s),
      tick: this.tick,
    };
  }

  /* ───────────────────────── the scheduler ───────────────────────── */

  /** Advance the system by one tick (1 ms). */
  step() {
    this.tick++;
    const slot = this.tick % this.cfg.traceLen;

    // 1. Interrupt service routines.
    this.traceIsr[slot] = 0;
    if (this.isrPending.length) {
      const pending = this.isrPending;
      this.isrPending = [];
      const api = this._isrApi();
      for (const isr of pending) {
        this.isrCount++;
        try {
          isr.handler(api);
        } catch (e) {
          this.log('crit', 'isr', `${isr.name}: ${e.message}`);
        }
      }
      this.traceIsr[slot] = 1;
    }

    // 2. Tick interrupt: unblock tasks whose delay or timeout has expired.
    for (const t of this.blocked) {
      if (t.wakeTick <= this.tick) this._unblock(t, this._timeoutValue(t));
    }

    // 3. Pick a task and give it this tick of CPU.
    let consumed = false;
    let guard = 0;
    let ran = null;
    while (!consumed && guard++ < 64) {
      const t = this._pick();
      if (!t) break;
      if (t !== this.current) {
        if (this.current && this.current.state === TaskState.RUNNING) this.current.state = TaskState.READY;
        this.contextSwitches++;
        this.current = t;
      }
      t.state = TaskState.RUNNING;
      consumed = this._exec(t);
      if (consumed) ran = t;
      if (t.state === TaskState.RUNNING && !consumed) t.state = TaskState.READY;
    }
    if (ran && ran.state === TaskState.RUNNING) {
      // Time slicing: rotate equal-priority tasks every tick.
      if (this.cfg.preemptive && this.cfg.timeSlicing) {
        const list = this.ready[ran.priority];
        if (list.length > 1 && list[0] === ran) {
          list.shift();
          list.push(ran);
        }
      }
    }

    // 4. Trace + statistics.
    this.trace[slot] = ran ? ran.row : -1;
    const base = slot * MAX_ROWS;
    this.stateTrace.fill(0, base, base + MAX_ROWS);
    for (const t of this.tasks) {
      let s = TraceState.READY;
      if (t === ran) s = t.priority !== t.basePriority ? TraceState.RUNNING_BOOSTED : TraceState.RUNNING;
      else if (t.state === TaskState.BLOCKED) s = TraceState.BLOCKED;
      else if (t.state === TaskState.SUSPENDED) s = TraceState.SUSPENDED;
      this.stateTrace[base + t.row] = s;
    }
    if (this.tick % this.cfg.statsWindow === 0) {
      let idle = 0;
      for (const t of this.tasks) {
        t.cpu = t.win / this.cfg.statsWindow;
        t.win = 0;
        if (t.spec.idle) idle = t.cpu;
      }
      this.cpuLoad = 1 - idle;
    }
    if (ran && ran.state === TaskState.RUNNING && ran.runLeft === 0) {
      // Burst finished; it'll pick up its next op next time it's scheduled.
    }
  }

  /** Highest-priority ready task (cooperative mode: keep the current one). */
  _pick() {
    if (!this.cfg.preemptive && this.current && this._isReady(this.current)) return this.current;
    for (let p = this.cfg.maxPriorities - 1; p >= 0; p--) {
      if (this.ready[p].length) return this.ready[p][0];
    }
    return null;
  }

  _isReady(t) {
    return t.state === TaskState.READY || t.state === TaskState.RUNNING;
  }

  _higherReady(t) {
    if (!this.cfg.preemptive) return false;
    for (let p = this.cfg.maxPriorities - 1; p > t.priority; p--) if (this.ready[p].length) return true;
    return false;
  }

  /** Run task t for (at most) one tick. Returns true if the tick was consumed. */
  _exec(t) {
    let steps = 0;
    for (;;) {
      if (t.runLeft > 0) {
        if (this._higherReady(t)) return false; // preempted mid-burst
        t.runLeft--;
        t.runTicks++;
        t.win++;
        return true;
      }
      if (++steps > 200) {
        // A task looping without ever consuming CPU: charge it a tick.
        t.runTicks++;
        t.win++;
        return true;
      }
      let r;
      try {
        r = t.gen.next(t.pendingValue);
      } catch (e) {
        this._fault(t, e);
        return false;
      }
      t.pendingValue = undefined;
      if (r.done) {
        this.log('info', 'kernel', `${t.name} returned`);
        this.deleteTask(t, 'returned');
        return false;
      }
      const blocked = this._handleOp(t, r.value);
      if (t.state === TaskState.DELETED) return false;
      if (blocked) return false;
      if (this._higherReady(t)) return false;
    }
  }

  _fault(t, e) {
    if (e instanceof StackOverflowError) {
      t.fault = 'stack overflow';
      this.log('crit', 'kernel', `vApplicationStackOverflowHook: ${e.message}`);
      this.hooks.stackOverflow?.(t, e);
    } else {
      t.fault = e.message;
      this.log('crit', 'kernel', `Task ${t.name} faulted: ${e.message}`);
    }
    this.deleteTask(t, 'faulted');
  }

  /** Execute a kernel API call yielded by a task. Returns true if the task blocked/yielded. */
  _handleOp(t, op) {
    if (!op || typeof op !== 'object') return false;
    switch (op.op) {
      case 'run':
        t.runLeft = Math.max(1, Math.round(op.n));
        return false;

      case 'delay':
        if (op.n <= 0) return this._yield(t);
        this._block(t, 'delay', null, this.tick + op.n);
        return true;

      case 'delayUntil': {
        t.jobs++;
        const next = t.lastWake + op.period;
        if (next <= this.tick) {
          // Previous job overran its period: deadline miss.
          t.missed++;
          t.lastWake = this.tick;
          return false;
        }
        t.lastWake = next;
        this._block(t, 'delay', null, next);
        return true;
      }

      case 'yield':
        return this._yield(t);

      case 'send': {
        const { q, item, timeout, front } = op;
        if (this._queueSendNonBlocking(q, item, front)) {
          t.pendingValue = true;
          return false;
        }
        if (!timeout) {
          t.pendingValue = false;
          return false;
        }
        t.sendItem = item;
        t.sendFront = !!front;
        this._insertByPriority(q.sendWaiters, t);
        this._block(t, 'send', q, this.tick + timeout);
        return true;
      }

      case 'recv': {
        const { q, timeout } = op;
        if (q.items.length) {
          t.pendingValue = this._queueTake(q);
          return false;
        }
        if (!timeout) {
          t.pendingValue = null;
          return false;
        }
        this._insertByPriority(q.recvWaiters, t);
        this._block(t, 'recv', q, this.tick + timeout);
        return true;
      }

      case 'take': {
        const { m, timeout } = op;
        if (m.kind === 'mutex') return this._mutexTake(t, m, timeout);
        if (m.count > 0) {
          m.count--;
          t.pendingValue = true;
          return false;
        }
        if (!timeout) {
          t.pendingValue = false;
          return false;
        }
        this._insertByPriority(m.waiters, t);
        this._block(t, 'take', m, this.tick + timeout);
        return true;
      }

      case 'give': {
        const { m } = op;
        if (m.kind === 'mutex') {
          if (m.owner !== t) {
            t.pendingValue = false;
            this.log('warn', t.name, `give(${m.name}) by non-owner`);
            return false;
          }
          this._mutexRelease(m, t);
        } else {
          this._semGive(m);
        }
        t.pendingValue = true;
        return false;
      }

      default:
        throw new Error(`Unknown kernel op ${op.op}`);
    }
  }

  _yield(t) {
    const list = this.ready[t.priority];
    const i = list.indexOf(t);
    if (i >= 0) {
      list.splice(i, 1);
      list.push(t);
    }
    return true;
  }

  /* ───────────────────────── mutex internals ───────────────────────── */

  _mutexTake(t, m, timeout) {
    if (!m.owner) {
      m.owner = t;
      m.takes++;
      m.heldSince = this.tick;
      t.held.push(m);
      t.pendingValue = true;
      return false;
    }
    if (m.owner === t) {
      t.pendingValue = true; // treat as recursive no-op
      return false;
    }
    m.contentions++;
    if (!timeout) {
      t.pendingValue = false;
      return false;
    }
    this._insertByPriority(m.waiters, t);
    this._block(t, 'take', m, this.tick + timeout);
    if (this.cfg.priorityInheritance) this._inherit(m.owner, t.priority, m);
    return true;
  }

  _inherit(owner, prio, via, depth = 0) {
    if (!owner || depth > 8) return;
    if (owner.priority < prio) {
      this.log('info', 'kernel', `Priority inheritance: ${owner.name} ${owner.priority}→${prio} (holds ${via.name})`);
      this._setEffectivePriority(owner, prio);
      // Transitive inheritance if the owner is itself waiting on a mutex.
      if (owner.state === TaskState.BLOCKED && owner.blockedOn?.kind === 'mutex') {
        this._inherit(owner.blockedOn.owner, prio, owner.blockedOn, depth + 1);
      }
    }
  }

  _recalcPriority(t) {
    let p = t.basePriority;
    if (this.cfg.priorityInheritance) {
      for (const m of t.held) if (m.waiters.length) p = Math.max(p, m.waiters[0].priority);
    }
    if (p !== t.priority) {
      if (p < t.priority && t.priority > t.basePriority) {
        this.log('info', 'kernel', `Priority disinherit: ${t.name} ${t.priority}→${p}`);
      }
      this._setEffectivePriority(t, p);
    }
  }

  _setEffectivePriority(t, p) {
    const inReady = this._readyRemove(t);
    t.priority = p;
    if (inReady) this._readyAdd(t);
    if (t.state === TaskState.BLOCKED && t.blockedOn) {
      const list = this._waitList(t);
      if (list) {
        const i = list.indexOf(t);
        if (i >= 0) list.splice(i, 1);
        this._insertByPriority(list, t);
      }
    }
  }

  _mutexRelease(m, owner) {
    owner.held = owner.held.filter((x) => x !== m);
    m.owner = null;
    this._recalcPriority(owner);
    if (m.waiters.length) {
      const w = m.waiters.shift();
      m.owner = w;
      m.takes++;
      m.heldSince = this.tick;
      w.held.push(m);
      this._unblock(w, true);
      if (this.cfg.priorityInheritance && m.waiters.length) this._inherit(w, m.waiters[0].priority, m);
    }
  }

  _semGive(s) {
    s.gives++;
    if (s.waiters.length) {
      const w = s.waiters.shift();
      this._unblock(w, true);
      return true;
    }
    if (s.count < s.max) {
      s.count++;
      return true;
    }
    return false;
  }

  /* ───────────────────────── queue internals ───────────────────────── */

  _queueSendNonBlocking(q, item, front) {
    if (q.recvWaiters.length) {
      q.sent++;
      const w = q.recvWaiters.shift();
      this._unblock(w, item);
      return true;
    }
    if (q.items.length < q.capacity) {
      q.sent++;
      if (front) q.items.unshift(item);
      else q.items.push(item);
      q.hwm = Math.max(q.hwm, q.items.length);
      return true;
    }
    q.drops++;
    return false;
  }

  _queueTake(q) {
    const item = q.items.shift();
    if (q.sendWaiters.length) {
      const s = q.sendWaiters.shift();
      if (s.sendFront) q.items.unshift(s.sendItem);
      else q.items.push(s.sendItem);
      q.sent++;
      s.sendItem = undefined;
      this._unblock(s, true);
    }
    return item;
  }

  /* ───────────────────────── list helpers ───────────────────────── */

  _insertByPriority(list, t) {
    let i = 0;
    while (i < list.length && list[i].priority >= t.priority) i++;
    list.splice(i, 0, t);
  }

  _readyAdd(t) {
    const list = this.ready[t.priority];
    if (!list.includes(t)) list.push(t);
  }

  _readyRemove(t) {
    const list = this.ready[t.priority];
    const i = list.indexOf(t);
    if (i >= 0) {
      list.splice(i, 1);
      return true;
    }
    return false;
  }

  _block(t, kind, obj, wakeTick) {
    this._readyRemove(t);
    t.state = TaskState.BLOCKED;
    t.blockKind = kind;
    t.blockedOn = obj;
    t.blockedSince = this.tick;
    t.wakeTick = wakeTick;
    this.blocked.add(t);
  }

  _unblock(t, value) {
    const obj = t.blockedOn;
    this._removeFromWaitLists(t);
    this.blocked.delete(t);
    t.pendingValue = value;
    t.blockKind = null;
    t.blockedOn = null;
    t.wakeTick = Infinity;
    t.state = TaskState.READY;
    this._readyAdd(t);
    // A timed-out waiter may have been boosting the mutex owner.
    if (obj?.kind === 'mutex' && obj.owner && obj.owner !== t) this._recalcPriority(obj.owner);
  }

  _waitList(t) {
    const o = t.blockedOn;
    if (!o) return null;
    if (o.kind === 'queue') return t.blockKind === 'send' ? o.sendWaiters : o.recvWaiters;
    return o.waiters;
  }

  _removeFromWaitLists(t) {
    const list = this._waitList(t);
    if (list) {
      const i = list.indexOf(t);
      if (i >= 0) list.splice(i, 1);
    }
  }

  _timeoutValue(t) {
    switch (t.blockKind) {
      case 'recv':
        return null;
      case 'send':
      case 'take':
        return false;
      default:
        return undefined;
    }
  }

  /* ───────────────────────── analysis ───────────────────────── */

  /** Wait-for graph edges: task -> task it waits on (via mutex ownership). */
  waitForEdges() {
    const edges = [];
    for (const t of this.tasks) {
      if (t.state === TaskState.BLOCKED && t.blockedOn?.kind === 'mutex' && t.blockedOn.owner) {
        edges.push({ from: t, to: t.blockedOn.owner, via: t.blockedOn });
      }
    }
    return edges;
  }

  /** Returns the tasks forming a cycle in the wait-for graph, or null. */
  findDeadlock() {
    const next = new Map();
    for (const e of this.waitForEdges()) next.set(e.from, e);
    for (const start of next.keys()) {
      const path = [];
      const seen = new Set();
      let cur = start;
      while (cur && next.has(cur) && !seen.has(cur)) {
        seen.add(cur);
        path.push(cur);
        cur = next.get(cur).to;
      }
      if (cur && seen.has(cur)) {
        const i = path.indexOf(cur);
        return path.slice(i);
      }
    }
    return null;
  }

  stackHWM(t) {
    return t.stackWords - t.stackPeak;
  }

  /* ───────────────────────── task-facing API ───────────────────────── */

  _api(t) {
    const k = this;
    return {
      /** Consume n ticks of CPU (preemptible). */
      run: (n) => ({ op: 'run', n }),
      /** vTaskDelay */
      delay: (n) => ({ op: 'delay', n }),
      /** vTaskDelayUntil (periodic release; counts deadline misses) */
      delayUntil: (period) => ({ op: 'delayUntil', period }),
      /** taskYIELD */
      yield: () => ({ op: 'yield' }),
      /** xQueueSend / xQueueSendToFront */
      send: (q, item, timeout = 0, front = false) => ({ op: 'send', q, item, timeout, front }),
      /** xQueueReceive -> item | null */
      recv: (q, timeout = Infinity) => ({ op: 'recv', q, timeout }),
      /** xSemaphoreTake -> boolean */
      take: (m, timeout = Infinity) => ({ op: 'take', m, timeout }),
      /** xSemaphoreGive */
      give: (m) => ({ op: 'give', m }),
      /** Report liveness to the software watchdog. */
      kick: () => {
        t.lastKick = k.tick;
      },
      /** Set current stack depth (words above the base frame). Throws on overflow. */
      stack: (words) => {
        t.stackCur = t.stackBase + words;
        t.stackPeak = Math.max(t.stackPeak, t.stackCur);
        if (t.stackCur > t.stackWords) throw new StackOverflowError(t, t.stackCur);
      },
      /** pvPortMalloc -> address | null */
      malloc: (bytes, tag) => {
        const a = k.heap.malloc(bytes, t.name, tag);
        if (a === null) {
          k.log('crit', 'kernel', `pvPortMalloc(${bytes}) failed in ${t.name} — vApplicationMallocFailedHook`);
          k.hooks.mallocFailed?.(t.name, bytes);
        }
        return a;
      },
      /** vPortFree */
      free: (addr) => k.heap.free(addr),
      log: (level, msg) => k.log(level, t.name, msg),
      now: () => k.tick,
      self: t,
    };
  }
}
