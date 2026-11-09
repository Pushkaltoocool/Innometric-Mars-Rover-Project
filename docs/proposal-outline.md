# Project proposal: outline for the slides

**OS PBL 2026 · Secure the Quality of OS in Spacecraft · Task 3: Mars Rover Exploration System**
**Team Innometric (Team 5)** · Proposal presentation: Week 11, Tue 10 Nov 2026 · 15 min including Q&A · at most 15 slides

This file is the source for the deck. Part 1 is the story and the slide-by-slide plan. Parts 2 to 9 hold the content for each section the guideline requires (Week 10 brief, slide 30). Copy from them into the slides.

---

## Part 1. The story

**The one-line pitch.** Mars is 3 to 22 light-minutes from Earth, so nobody can press reset on a rover. Every Mars rover so far has taught engineers an operating-systems lesson the hard way. We turn those lessons into the design of our rover's software on FreeRTOS, and show each one happening live.

**The arc.**

1. **Hook.** July 1997: Pathfinder keeps rebooting on Mars, and the cause is a textbook OS bug.
2. **Why it matters.** Four rovers, four OS lessons, laid out as a timeline.
3. **Our mission.** Task 3, and what the rover's software has to do.
4. **Design.** Seven modules become ten tasks, connected by queues and locks.
5. **Problems.** Everything that can go wrong, each mapped to a lecture concept and our fix.
6. **Two deep dives.** Deadlock (prevention, avoidance, detection, recovery) and priority inversion.
7. **Proof.** A live demo of the prototype.
8. **Plan.** What we still need to find out, our limits, our goals, and the timeline to Week 15.
9. **Close.** "Perseverance can't call for help. Its OS has to be the help."

### Slide plan (15 slides, about 11 min talk and 4 min Q&A)

The speakers below follow the team R&R. Change them as you like.

| # | Slide headline (write it as a sentence) | Guideline section | Speaker | Time |
|---|---|---|---|---|
| 1 | RoverOS: keeping Perseverance alive with a real-time OS | 1. Cover | Pushkal | 0:20 |
| 2 | July 1997: Pathfinder keeps rebooting on Mars | Hook (part of 3) | Pushkal | 0:50 |
| 3 | Every rover taught us an OS lesson | Background (3) | Pushkal | 0:50 |
| 4 | Our project in one slide | 2. Summary | Pushkal | 0:45 |
| 5 | Seven modules, one CPU: the problem from an OS view | 3. Problem | Diganta | 0:45 |
| 6 | Our design: ten tasks, three queues, three locks | 3. Problem / design | Diganta | 0:50 |
| 7 | What can go wrong, part 1: time and communication | Issues → concepts | Fatima | 0:50 |
| 8 | What can go wrong, part 2: memory, faults, power | Issues → concepts | Mai | 0:50 |
| 9 | Deadlock: we prevent it and keep a safety net | Deep dive | Pushkal | 0:50 |
| 10 | Priority inversion, live (demo) | Deep dive + demo | Alavee | 2:00 |
| 11 | What we still need to find out | 4. Investigate | Alavee | 0:40 |
| 12 | Our limits | 5. Constraints | Pujan | 0:35 |
| 13 | Goals and how we will measure success | 6. Goals | Mai | 0:40 |
| 14 | Timeline to Week 15, and risks | 7. Schedule | Pujan | 0:45 |
| 15 | References · Questions | 8. References | All | rest |

**Visual direction.** Use NASA/JPL imagery: Perseverance on Jezero, the Pathfinder lander, Curiosity's wheels, Spirit. Most NASA images are free to use with credit ("NASA/JPL-Caltech"). Use dark slides with one image per slide and few words. Put the detail in speaker notes, not on the slide. Our 3D demo screenshots (Step mode, the scheduler timeline, the resource-allocation graph) work as the "proof" images.

---

## Part 2. Slide content

### Slide 1: Cover

- **Course:** Operating Systems (PBL), Woosong University, Fall 2026. Professor Daeryong Lee.
- **Project:** Secure the Quality of OS in Spacecraft, Task 3: Mars Rover Exploration System.
- **Title:** RoverOS: keeping Perseverance alive with a real-time OS.
- **Team Innometric (Team 5):**

| Member | Technical role | Team role |
|---|---|---|
| Vashist Pushkal | System architecture and integration (Main Computer task), synchronization and deadlock analysis | Leader |
| Mojumder Diganta | Driver/Motor and Navigation tasks | Co-leader |
| Fatima Laraib | Sensor and Communication tasks | Report writer |
| Ngo Thi Ngoc Mai | Power management and Self-Monitor tasks | Meeting notes |
| Alavee Ahmed | Testing and visualization | Presentation maker |
| Kharal Pujan | Repository and environment (GitHub, Notion, FreeRTOS simulator) | |

**Image:** Perseverance selfie at Jezero (NASA/JPL-Caltech/MSSS).

### Slide 2: July 1997, Pathfinder keeps rebooting on Mars

On screen: one image of the Pathfinder lander and Sojourner, plus three short lines:

- Days after landing on 4 July 1997, the lander's computer starts **resetting itself**, and data is lost each time.
- The cause was not hardware. It was **priority inversion**:
  - a low-priority weather task held a shared bus lock
  - medium-priority tasks kept preempting it
  - the high-priority bus task waited too long
  - a watchdog decided the system had hung and reset it
- JPL engineers reproduced it on Earth and uploaded a fix: **turn on priority inheritance** for that lock.

**Speaker note.** "This is the bug from Week 6 and Week 7 of our lectures (mutual exclusion plus priority scheduling), 190 million km away. Our project starts here."

### Slide 3: Every rover taught us an OS lesson (timeline)

Draw this as a horizontal timeline across the slide.

| Year | Rover | What happened | OS lesson | Our scenario |
|---|---|---|---|---|
| 1997 | **Mars Pathfinder + Sojourner** | Reset loop from priority inversion on the information-bus lock (VxWorks RTOS) | Scheduling and synchronization interact. Use priority inheritance. | Priority inversion |
| 2004 | **Spirit** (and Opportunity) | On Sol 18 Spirit fell into a reboot loop. Too many files in flash memory used up the RAM needed to manage them. It was fixed by booting without flash and deleting files. | Memory is a finite resource; exhaustion takes down everything | Memory leak |
| 2012 | **Curiosity** | Feb 2013: corrupted memory on the main computer, so the team switched to the redundant backup computer. Sharp rocks also punctured its wheels. | Detect faults and recover; avoid hazards before you hit them | Watchdog / hang, hazard avoidance |
| 2021 | **Perseverance + Ingenuity** | Perseverance drives itself with AutoNav, helped by a dedicated vision computer. Before its first flight, Ingenuity's **watchdog timer** expired during a spin test, and the flight was delayed for a software fix. | Real-time deadlines, offloading work, watchdogs | CPU overload, Step mode |

**Speaker note.** "Each of these is a chapter in our textbook. Our rover runs all of these problems on purpose and shows the OS solving them."

### Slide 4: Our project in one slide (Summary)

- **Core issue.** A rover runs 7 functional modules at once on one CPU, sharing buses, memory and power, with nobody nearby to reboot it. Task 3 asks whether FreeRTOS task management keeps such a system stable.
- **Hypothesis.** Most rover failures come from task interaction (priorities, locks, queues, memory), not from any single module. If we:
  - choose priorities deliberately
  - use priority-inheriting mutexes
  - enforce a lock order
  - size stacks and the heap from measurements
  - add a self-monitoring watchdog

  then the system stays stable even under faults.
- **Resolution direction.**
  1. Model the modules as FreeRTOS tasks.
  2. Inject each failure on purpose.
  3. Show the failure without the OS mechanism and recovery with it.
  4. Measure both.
- **Technical objectives versus learning objectives:**

| Technical (what we build) | Learning (what we understand) |
|---|---|
| 10 FreeRTOS tasks with queues, mutexes and a semaphore | How lecture concepts (Ch. 3–9) behave in a running RTOS |
| 7 reproducible fault scenarios, each with and without a fix | Why each fix works, and what it costs |
| Measurements: blocking time, deadline misses, stack and heap headroom | Trade-offs such as prevention versus avoidance, and static versus dynamic priority |
| A visualiser that shows the OS working in real time | How to explain OS behaviour to non-experts |

### Slide 5: Seven modules, one CPU, from an OS view (Problem)

- **Background.** Task 3 brief: Driver/Motor, Sensor, Communication, Navigation, Power, Self-Monitor, Main Computer.
- **Limits of the obvious approach:**
  - A **super-loop** (one big `while(1)` that calls each module in turn) breaks if any module is slow, because hazard detection then waits behind image compression.
  - **Naive locking** brings deadlock and inversion.
  - **No monitoring** means a single hung module freezes the rover.
- **From the OS perspective,** each module is a process or thread (Ch. 3–4) competing for:
  - **CPU time**: scheduling (Ch. 8)
  - **shared devices**: mutual exclusion (Ch. 5–6)
  - **memory**: real memory management (Ch. 9)
  - **each other's data**: IPC (Ch. 3)

  Failures happen at the boundaries between modules.
- **Mars-specific pressure:**
  - 3 to 22 minutes one-way signal delay, so the rover must be autonomous
  - limited power (an MMRTG supplies about 110 W)
  - real time: a hazard must be seen before the rover reaches it

### Slide 6: Our design, ten tasks, three queues, three locks

Draw this as a diagram. Higher priority goes at the top.

| Prio | Task | Module | Period | Talks through |
|---|---|---|---|---|
| 7 | SelfMonitor | Self-Monitor | 250 ms | Watchdog, deadlock detection, heap audit, load shedding |
| 6 | HazardAvoid | Driver: obstacle avoidance | 50 ms | SensorBus mutex; E-stop to the front of MotorQueue |
| 5 | MotorCtrl | Driver: motors | 20 ms | Receives from MotorQueue |
| 4 | MainComputer | Main Computer | on command | Receives from CmdQueue and dispatches |
| 4 | Power | Power | 1 s | Suspends and resumes tasks by power mode |
| 3 | Navigation | Navigation | 100 ms | A* path planning, route history |
| 2 | Sensor | Sensor | 500 ms | SensorBus; PowerRail then CameraMutex |
| 2 | ArmCtrl | Sensor (sampling) | on trigger | ArmTrigger semaphore; PowerRail then CameraMutex |
| 1 | Comm | Communication | on data | TelemetryQueue; SensorBus |
| 0 | IDLE | none | none | Runs when nothing else is ready |

- **Command path (draw it as arrows):**

  ```
  operator → keyboard ISR → CmdQueue → MainComputer → MotorQueue → MotorCtrl → wheels
  ```

  HazardAvoid can push an E-stop to the front of MotorQueue.
- **Shared resources.** The rover has fewer buses than tasks (SensorBus, PowerRail, CameraMutex). That is realistic, and it is what creates contention.
- **Why these priorities.** We started from **rate-monotonic** order (Ch. 8: shorter period means higher priority), then deliberately raised two tasks for **criticality**:
  - SelfMonitor must preempt everything, or it can't catch a hung task.
  - HazardAvoid outranks MotorCtrl because stopping matters more than driving.

  Checking that this order still meets every deadline is an investigation item (slide 11).
- **Prototype measurement** (20 s of driving): total CPU load about 17.5%, about 157 context switches per second, 0 deadline misses.

### Slide 7: What can go wrong, part 1 (time and communication)

| # | Issue on the rover | What it looks like on Mars | Lecture concept (chapter, week) | How we solve it |
|---|---|---|---|---|
| 1 | Many modules, one CPU | Hazard scan waits behind image compression | Process states, context switch, PCB/TCB (Ch. 3, Week 3); preemptive versus non-preemptive (Ch. 8, Week 7) | Each module is a FreeRTOS task with its own TCB and stack. **Preemptive fixed-priority** scheduling, with round robin between equal priorities. |
| 2 | Hard deadlines | MotorCtrl must update every 20 ms and HazardAvoid every 50 ms | Real-time scheduling: hard versus soft, **rate-monotonic**, deadline scheduling, EDF (Ch. 8, Week 7) | Periodic tasks use `vTaskDelayUntil` (fixed rate, no drift). Static priorities follow RM, adjusted for criticality. Missed deadlines are counted. |
| 3 | Commands arrive at random times | Operator or Earth commands interrupt whatever is running | Interrupts and interrupt classes (Ch. 3, Week 3) | ISR does the minimum, using `xQueueSendFromISR` to CmdQueue. A task does the real work (deferred interrupt processing). |
| 4 | Modules must exchange data safely | Telemetry produced faster than the radio can send it | IPC by message passing (Ch. 3); producer–consumer and circular bounded buffer (Ch. 5–6, Weeks 5–6) | **FreeRTOS queues**: bounded FIFO buffers with blocking send and receive and timeouts. We watch queue length and drops. |
| 5 | Shared hardware | Two tasks talk on the SensorBus at the same time and corrupt the data | Mutual exclusion, critical sections, semaphores (Ch. 5, Week 5); monitors (Ch. 6) | **Mutexes** for SensorBus, PowerRail and CameraMutex. A **binary semaphore** signals the arm. Critical sections are kept short. |
| 6 | **Priority inversion** (Pathfinder 1997) | HazardAvoid waits on the bus while a medium task runs, and the rover hits a rock | Priority scheduling with mutual exclusion; indefinite postponement (Ch. 7–8) | **Priority inheritance** (FreeRTOS mutexes). Alternatives we compare: priority ceiling, a gatekeeper task owning the bus. |
| 7 | Starvation under overload | Comm never gets the CPU, so no data reaches Earth | Indefinite postponement and **aging** (Ch. 7, Week 6); CPU utilization (Ch. 8) | SelfMonitor detects a CPU hog and **sheds load** by demoting it. Aging (gradually raising a starved task) is the alternative we evaluate. |

### Slide 8: What can go wrong, part 2 (memory, faults, power)

| # | Issue on the rover | What it looks like on Mars | Lecture concept (chapter, week) | How we solve it |
|---|---|---|---|---|
| 8 | **Deadlock** | Arm holds Camera and waits for Power while Sensor holds Power and waits for Camera; both freeze | Four necessary conditions; prevention, avoidance, detection, recovery; resource-allocation graphs (Ch. 7, Week 6) | **Prevention** by a global lock order, plus **detection and recovery** as a safety net. See slide 9. |
| 9 | Stack overflow | Deep recursion in terrain processing overwrites a neighbour's memory | Fixed partitions and memory protection (Ch. 9, Week 7) | Each task gets a fixed stack. `configCHECK_FOR_STACK_OVERFLOW` plus a hook, and sizes taken from the measured **high-water mark** plus a margin. |
| 10 | Heap exhaustion and fragmentation (Spirit 2004) | Image buffers never freed, until the next allocation fails | Variable partitions, **first fit**, **coalescing**, fragmentation (Ch. 9, Week 7) | **heap_4** (first fit with coalescing). Allocate at start-up where possible. A heap audit uses the minimum-ever-free-heap figure. |
| 11 | A task hangs | Navigation loops forever and the rover stops planning | Deadlock recovery by killing or restarting the victim (Ch. 7) | **Software watchdog**: every task "kicks" SelfMonitor, which restarts any task that goes silent. |
| 12 | Power runs low | Battery low at night | Suspend and resume (Ch. 3, Week 3); dynamic priorities (Ch. 8) | Power task changes mode and uses `vTaskSuspend` and `vTaskResume` on non-essential tasks. |
| 13 | No virtual memory | All tasks share one address space, so a bad pointer in one task can break another | Virtual memory, paging, segmentation (Ch. 10–11, Week 8) | **Not available**: FreeRTOS on a microcontroller has no MMU. This is *why* items 9 and 10 matter so much, and we discuss it as a design limit. |

### Slide 9: Deadlock, we prevent it and keep a safety net

**Our deadlock (from the design):**

- ArmCtrl takes CameraMutex, then PowerRail.
- Sensor takes PowerRail, then CameraMutex.

All four conditions hold:

- **mutual exclusion:** a bus serves one task at a time
- **hold-and-wait:** a task holds one lock while waiting for the other
- **no preemption:** the kernel cannot take a mutex away from a task
- **circular wait:** Arm waits for Sensor, and Sensor waits for Arm

| Strategy (Ch. 7) | How it would work on the rover | Cost | Decision |
|---|---|---|---|
| **Prevention: deny circular wait** | Global lock order: PowerRail before CameraMutex before SensorBus | Programmers must follow the order, and it is less flexible | **Primary** |
| Prevention: deny hold-and-wait | One combined "imaging" lock, so a task takes everything at once | Wastes resources: the arm blocks the camera even when it only needs power | Considered |
| Prevention: deny no-preemption | Take with a timeout; on timeout, release everything and retry with backoff | Lost work and possible livelock | Secondary guard |
| **Avoidance: Banker's algorithm** | Each task declares its maximum claim, and the kernel grants only safe states | Needs maximum claims in advance and adds overhead on every request; FreeRTOS has no support; waits become unpredictable, which is bad for real time | **Rejected**, with reasons |
| **Detection and recovery** | SelfMonitor builds the **wait-for graph** every 250 ms. On a cycle, it restarts the lowest-priority task in the cycle and force-releases its locks | The victim loses its work | **Safety net** |

**Demo image.** Resource-allocation graph with the red cycle, next to the same scenario with lock ordering, where no cycle forms.

### Slide 10: Priority inversion, live (demo, about 2 minutes)

1. Open the demo. Priority inversion is the first button at the bottom.
2. **Run without priority inheritance.**
   - Comm (priority 1) holds SensorBus, and a medium task (priority 3) floods the CPU.
   - HazardAvoid (priority 6) is blocked, and the **rover hits the boulder.**
3. **Run with priority inheritance.**
   - Comm is boosted from 1 to 6 (shown in amber on the timeline) and releases the bus quickly.
   - The **rover stops** in time.
4. Optional, 30 s: **Step mode** (the Step button, or N).
   - Press W, then *Next event*. The audience sees the key press become an interrupt, then a CmdQueue message, then a context switch to MainComputer, then a MotorQueue message, then the wheels.
   - This is the OS, one decision at a time.

**Speaker note.** "This is the Pathfinder bug from slide 2, running on our rover, and the same one-line fix."

### Slide 11: What we still need to find out (Things to investigate)

**Technical uncertainty:**

1. **FreeRTOS inheritance limits.**
   - FreeRTOS uses a simplified inheritance scheme, designed around a task holding one mutex at a time.
   - What happens when a task holds two mutexes, or the inversion is chained across several tasks?
   - Test it, and read the kernel source (`xTaskPriorityInherit`, `xTaskPriorityDisinherit`).
2. **Schedulability of our priority order.**
   - Our order is not pure rate-monotonic. Run a response-time analysis for each periodic task.
   - The Liu & Layland RM bound for 6 tasks is about 73.5%; our measured load is about 17.5%.
3. **Stack sizes.** Measure `uxTaskGetStackHighWaterMark` under the worst scenario. Compare overflow-check method 1 with method 2.
4. **Heap scheme.** Compare heap_1, 2, 4 and 5, and fragmentation under image buffers. Can we allocate everything statically at start-up (`xTaskCreateStatic`)?
5. **Gatekeeper versus mutex.** Should SensorBus be owned by one gatekeeper task (the FreeRTOS book's pattern), which removes the mutex and the inversion entirely?
6. **Watchdog timeouts.** What timeout avoids false resets while still catching real hangs?

**Experiments and analysis:**

7. **Timing on the Win32 simulator.** Windows is not real-time. How much jitter is there, and can we measure in kernel ticks instead of wall-clock time?
8. **Trace bridge.** Can FreeRTOS trace hooks (`traceTASK_SWITCHED_IN`, …) stream the C version's events into our 3D visualiser?

### Slide 12: Our limits (Constraints)

- **Technical:**
  - We run on the **FreeRTOS Windows (Win32) simulator** from the course practicals (Visual Studio 2022), not real rover hardware. Sensors, motors and the radio are simulated.
  - The CPU is single-core. Windows adds timing jitter.
  - There is no MMU or virtual memory in FreeRTOS, so tasks are not isolated (slide 8, item 13).
- **Time:**
  - About 5 weeks (Week 11 to Week 15), including two presentations.
  - Six members, each taking other courses.
- **Tools and environment:**
  - GitHub (code) and Notion (collaboration history) are mandatory.
  - The prototype visualiser is JavaScript in the browser. It models FreeRTOS behaviour, but it is not FreeRTOS code.
- **Scope limits (we will not do):**
  - real flight algorithms (vision, terrain classification)
  - real communication protocols or encryption
  - multi-core scheduling
  - real-world rover speeds (the demo drives at about 2.4 m/s; Perseverance drives at about 0.042 m/s)
  - real power physics
- **Realism versus achievability** (Task 3 asks for this analysis): we simplify module internals to small CPU bursts, so that the *OS interactions* stay realistic.

### Slide 13: Goals and how we will measure success

**Technical goals, in priority order:**

| Priority | Goal | Success criterion |
|---|---|---|
| Must | 10 tasks running in FreeRTOS C on the Win32 simulator, with queues, mutexes and a semaphore, and a working command path | Each command reaches MotorCtrl within 25 ms (one MotorCtrl period plus dispatch) |
| Must | Priority inversion reproduced and fixed in C | Without inheritance, HazardAvoid's blocking time is unbounded. With it, blocking is limited to Comm's critical section (target under 10 ms). |
| Must | Deadlock reproduced; prevention by lock order, plus detection | 0 cycles over 1,000 arm and image requests with ordering. Without ordering, the cycle is detected and recovered within 1 s. |
| Should | Stack, heap, watchdog and overload scenarios in C | Every stack keeps at least 25% headroom. Minimum free heap stays at or above 20% over a 10-minute run. A hung task is restarted within 2 s. |
| Should | C trace replayed in the 3D visualiser | The same scenario looks the same in C and in the prototype |
| Could | Power modes, response-time analysis, gatekeeper comparison | A written comparison with measurements |

**Learning goals:**

- Explain every lecture concept on slides 7 and 8 using our own running system.
- Justify each design choice against its alternatives (for example prevention versus avoidance, or inheritance versus ceiling).
- Read and understand the FreeRTOS kernel source for mutexes and scheduling.
- Work as a team through GitHub and Notion, with every member owning code.

### Slide 14: Timeline to Week 15, and risks (Schedule)

Draw this as a timeline. Mark the presentations clearly.

| Week | Date | Milestone | Main work | Owner |
|---|---|---|---|---|
| 9 | 27 Oct | ✔ Team formed | Task 3 chosen, R&R, ground rules, Notion | All |
| 10 | 3 Nov | ✔ Research and prototype | Module research; JS prototype and visualiser (phase 1); proposal | All |
| **11** | **10 Nov** | **Proposal presentation** | Collect professor feedback and update the plan | All |
| 12 | 17 Nov | C port, part 1 | FreeRTOS Win32 project; 10 tasks; queues and command path; mutexes | Pujan (env), each member their tasks |
| | 21 Nov | *Interim check* | Internal code review; every task runs; trace log works | Pushkal |
| **13** | **24 Nov** | **Progress presentation** | Inversion and deadlock scenarios running and measured in C | Pushkal, Alavee |
| 14 | 1 Dec | Scenarios and analysis | Stack, heap, watchdog, overload, power; trace bridge to the visualiser; design-change analysis | Mai, Fatima, Diganta, Alavee |
| **15** | **8 Dec** | **Completion presentation** | Live demo; final GitHub and Notion; peer evaluation | All |

**Risks and responses:**

| Risk | Response |
|---|---|
| Windows timing jitter makes measurements noisy | Measure in kernel ticks with trace hooks, not wall-clock time; repeat runs |
| Concurrency bugs in C are hard to find | Use the JS prototype as the reference model; build one task at a time; use Step mode to explain the expected order |
| The trace bridge takes too long | Fall back to CSV log export and offline charts |
| A member is unavailable (exams, illness) | Pair ownership: each module has a backup person; weekly Notion check-in |
| Scope creep | Follow the Must, Should, Could order on slide 13; cut Could first |
| Professor feedback changes the focus | Fold the changes into the Week 12 plan before coding starts |

### Slide 15: References and questions

**Official documents and manuals:**

- R. Barry, *Mastering the FreeRTOS Real Time Kernel: A Hands-On Tutorial Guide*. freertos.org.
- *FreeRTOS Reference Manual*, and freertos.org pages on mutexes and priority inheritance, stack overflow checking, and heap memory management.
- FreeRTOS book companion source code: Win32-simulator-MSVC (course practical).

**Teaching materials:**

- H. M. Deitel, P. J. Deitel, D. R. Choffnes, *Operating Systems*, 3rd ed., Prentice Hall (course textbook).
- Course lectures 1–11, Woosong University, Fall 2026 (Prof. Daeryong Lee).
- PBL Project Brief: *Secure the Quality of OS in Spacecraft*.

**Papers and technical data:**

- L. Sha, R. Rajkumar, J. P. Lehoczky, "Priority Inheritance Protocols: An Approach to Real-Time Synchronization," *IEEE Transactions on Computers*, 39(9), 1990.
- C. L. Liu, J. W. Layland, "Scheduling Algorithms for Multiprogramming in a Hard-Real-Time Environment," *Journal of the ACM*, 20(1), 1973.
- G. Reeves, "What really happened on Mars?", authoritative account of the Pathfinder priority inversion, Dec 1997 (and M. Jones's summary of the same incident).
- G. Reeves, T. Neilson, "The Mars Rover Spirit FLASH Anomaly," *IEEE Aerospace Conference*, 2005.
- NASA/JPL mission pages and news releases for Curiosity (computer swap, 2013), Perseverance (AutoNav) and Ingenuity (watchdog before the first flight, 2021).
- Perseverance 3D model: NASA/JPL-Caltech (science.nasa.gov).

Before the slides go out, check every date and number on slide 3 against these sources.

---

## Part 3. Talking points for likely questions

- **"Is this real FreeRTOS?"**
  - The prototype is a JavaScript model of FreeRTOS behaviour, built so we can *see* the OS. It uses the same API concepts, scheduling rules and inheritance.
  - The graded implementation (Weeks 12–14) is FreeRTOS C on the Win32 simulator from our practicals.
  - The prototype is our reference model and visualiser.
- **"Why not Banker's algorithm?"**
  - It needs every task's maximum claim in advance and checks safety on every request.
  - It makes waiting times unpredictable, which is bad for hard real time, and FreeRTOS has no support for it.
  - Ordering prevents the cycle at zero runtime cost.
- **"Why is SelfMonitor the highest priority?"** A watchdog that can be starved can't catch the task that starves it.
- **"Why not priority ceiling?"**
  - It avoids chained blocking, but FreeRTOS mutexes implement inheritance, not ceiling.
  - We'd have to emulate it.
  - Comparing the two is on our investigate list.
- **"What about virtual memory (Week 8)?"**
  - Small RTOS targets usually have no MMU, so every task shares one address space.
  - That is exactly why we check stacks and audit the heap.

---

## Part 4. Notes for whoever builds the slides

- Write each headline as a full sentence (see the table in Part 1). Someone who reads only the headlines should still get the story.
- Use at most one idea and one image per slide. Put the detail tables (slides 7, 8, 9) in large type with short cells. Their full text is here, so cut freely.
- Reuse the colours from the demo: warm dark background, sand accent, amber for "inherited priority" or warnings, red only for failure.
- For slide 10, have the demo already open at `http://localhost:5173`, and keep a screen recording as a backup in case the live demo fails.
