# RoverOS: Perseverance on a real-time kernel

**OS PBL 2026, Task 3: Mars Rover Exploration System. Team Innometric (Team 5).**

NASA's Perseverance rover drives across a 3D Jezero Crater. Its flight software is split into ten tasks that run on a kernel which follows FreeRTOS behaviour. You can drive the rover yourself, and you can inject OS faults (priority inversion, deadlock, overload and others) to see what each one does to the rover physically.


## Run it

```bash
npm start          # → http://localhost:5173  (Node 18+, no npm install needed)
npm test           # headless kernel + scenario tests
```

Everything is bundled locally (three.js, fonts, the NASA model), so the demo works without internet.

| Input | Effect |
|---|---|
| `W A S D` / arrows | Drive. Each key press raises an interrupt, and the command passes through the RTOS before the wheels move |
| Click the terrain | AutoNav: the Navigation task plans a route with A* and follows it |
| `Space` | Emergency stop |
| `X` / `I` | Robotic-arm sample / Mastcam-Z image |
| `C` / `P` / `F` | Change camera / pause / show the hazcam field of view |

## The core idea

Most rover demos simply move a 3D model when you press a key. Here the keyboard is treated as **hardware**, and every command has to go through the operating system:

```
key press ──► Keyboard ISR ──► CmdQueue ──► MainComputer task ──► MotorQueue ──► MotorCtrl task ──► wheels
                                                                         ▲
                       HazardAvoid task ── hazcam scan over SensorBus ───┘ (E-stop)
```

If the scheduler doesn't give a task CPU time, or a task is stuck waiting on a lock, the rover physically misbehaves: it keeps driving on a stale command and can hit a rock. The OS decisions have visible consequences.

## Architecture

```
web/
  js/rtos/kernel.js      The kernel: scheduler, task states, queues, mutexes, semaphores, ISRs, tracing
  js/rtos/heap.js        heap_4-style allocator (first fit, block splitting, coalescing)
  js/rover/system.js     The 10 rover tasks + IPC objects (the "flight software")
  js/rover/scenarios.js  Fault-injection scripts
  js/world/terrain.js    Procedural Jezero terrain, rocks, obstacle grid, A* planner
  js/world/rover-sim.js  Rover physics: the plant the tasks sense and control
  js/world/scene.js      three.js rendering (NASA GLB model, wheels split so they spin/steer)
  js/ui/dashboard.js     Scheduler timeline, task table, resource-allocation graph, heap map, log
  assets/perseverance.glb  NASA/JPL-Caltech Perseverance 3D model
tests/scenarios.test.mjs   Headless tests that run every scenario without a browser
```

### The kernel (`kernel.js`)

The kernel reproduces FreeRTOS behaviour. The API names match FreeRTOS: `xTaskCreate`, `vTaskDelayUntil`, `xQueueSend`, `xSemaphoreTake`, `vTaskSuspend`, `pvPortMalloc`.

- **1 tick = 1 ms.** Each tick the kernel runs any pending interrupts, wakes tasks whose delay has expired, then gives one tick of CPU to the highest-priority Ready task.
- **Fixed-priority preemptive scheduling** with round-robin time slicing between equal priorities. Switching off *Preemptive scheduling* gives cooperative scheduling for comparison.
- **Task states:** Running, Ready, Blocked (delay, queue, mutex or semaphore), Suspended, Deleted.
- **Tasks are generator functions.** Each kernel call is `yield`ed, so a task can be preempted at any API call or in the middle of a CPU burst (`yield os.run(n)`).
- **Queues:** bounded, with blocking send and receive, timeouts, waiters ordered by priority, and ISR-safe sends.
- **Mutexes** with optional, transitive **priority inheritance**. **Binary semaphores** wake the arm.
- **Memory:** task control blocks and stacks are allocated from a 48 KiB heap, as with dynamic allocation in FreeRTOS. Stack high-water marks are tracked, and an overflow triggers a hook.
- **Analysis:**
  - CPU usage per task and context switches per second
  - deadline misses, detected when `vTaskDelayUntil` finds its deadline has already passed
  - a wait-for graph with cycle detection, used to find deadlocks

### The rover tasks (`system.js`)

These are the Task 3 functional modules turned into RTOS tasks:

| Prio | Task | Module (Task 3 spec) | Period | Uses |
|---|---|---|---|---|
| 7 | SelfMonitor | Self-Monitor | 250 ms | Watchdog, deadlock detection and recovery, heap audit, load shedding |
| 6 | HazardAvoid | Driver: obstacle avoidance | 50 ms | **SensorBus** mutex; sends E-stop to the front of MotorQueue |
| 5 | MotorCtrl | Driver / Motor | 20 ms | Drains **MotorQueue**, drives the wheels |
| 4 | MainComputer | Main Computer | event | Receives **CmdQueue**, dispatches commands |
| 4 | Power | Power | 1 s | Battery and MMRTG model; suspends and resumes tasks by power mode |
| 3 | Navigation | Navigation | 100 ms | Route history, recursive terrain segmentation (stack), A* (heap) |
| 2 | Sensor | Sensor | 500 ms | MEDA weather over **SensorBus**; Mastcam images (**PowerRail** then **CameraMutex**) |
| 2 | ArmCtrl | Sensor (sampling) | event | **ArmTrigger** semaphore, **CameraMutex** + **PowerRail** |
| 1 | Comm | Communication | event | Downlinks **TelemetryQueue** over **SensorBus**, retry with exponential backoff |
| 0 | IDLE | (none) | (none) | Runs when nothing else is ready; its share of the CPU gives the CPU load figure |

**Shared resources:** the rover deliberately has fewer buses than tasks, which is what makes contention happen.

- **SensorBus** is shared by the hazard cameras, MEDA and the radio.
- **PowerRail** and **CameraMutex** are shared by the mast camera and the arm.

## Fault-injection scenarios (the demo)

Each scenario injects a real OS failure mode. Where a fix exists, you can run the scenario with and without it.

| Scenario | OS concept | Without the fix | With the fix / recovery |
|---|---|---|---|
| **Priority inversion** | Mutex, priority inheritance | Comm (p1) holds SensorBus. ImageCompress (p3) preempts Comm. HazardAvoid (p6) waits on the bus, can't stop the rover, and **the rover hits the boulder**. This re-enacts the **1997 Mars Pathfinder** bug. | With inheritance, Comm is boosted 1→6 (amber in the timeline), releases the bus within about 140 ms, and the rover stops safely. |
| **Deadlock** | Circular wait, lock ordering | ArmCtrl takes Camera then PowerRail; Sensor takes PowerRail then Camera. The resource-allocation graph shows a red cycle. SelfMonitor detects it and restarts ArmCtrl, which releases its locks. | With **lock ordering**, every task takes PowerRail first, so no cycle can form. |
| **CPU overload** | Preemptive priority scheduling, starvation | A hog at p3 takes about 99% of the CPU. Sensor and Comm (lower priority) starve and their deadline misses climb. Higher-priority tasks keep running normally. | With **load shedding**, SelfMonitor demotes the hog to p1 after about 2 s. |
| **Task hang** | Software watchdog | Navigation loops forever and stops "kicking" the watchdog. | SelfMonitor restarts it. |
| **Stack overflow** | Stack high-water mark, overflow hook | Deep recursion overflows the 512-word stack, and the hook deletes the task. | Restarted with a 768-word stack. |
| **Memory leak** | heap_4, malloc-failed hook | Comm stops freeing image buffers and the heap runs out. | The heap audit reclaims the orphaned buffers. |
| **Low power** | Dynamic task management | The battery drops to 10%. Power moves through LOW to SAFE mode and suspends Sensor, Arm and Navigation. | As the MMRTG recharges the battery, the tasks are resumed. |

The *Inherited priority* colour, the resource-allocation graph and the heap map are there so each concept can be **seen** while it happens. Use 0.1× or 0.25× speed when presenting.

## Verification

`npm test` runs the kernel and every scenario headless (17 checks). It covers:
- preemption order, queue timeouts, deadlock detection and heap coalescing
- the **rover crashing without priority inheritance and stopping safely with it**
- deadlock detection and recovery, watchdog restart, stack-overflow restart, heap reclaim, load shedding and SAFE mode

## Honest limitations

- The kernel is a **JavaScript simulation of FreeRTOS behaviour**, not the FreeRTOS C source. It is single-core, has no real hardware timers, and uses simplified costs (each `run(n)` is n ms of CPU).
- Rover speed is about 2.4 m/s for the demo. The real Perseverance drives at about 0.042 m/s.
- Power drain and charging are sped up so the power modes show up within a demo.
- Possible next step: run the same tasks in C on the FreeRTOS Windows/POSIX port, and stream the trace into this visualiser.

## Credits

- Perseverance 3D model: NASA/JPL-Caltech ([science.nasa.gov](https://science.nasa.gov/resource/mars-perseverance-rover-3d-model/)).
- three.js (MIT). IBM Plex (SIL OFL 1.1).
- Kernel behaviour modelled on *Mastering the FreeRTOS Real Time Kernel* and the FreeRTOS Reference Manual.
