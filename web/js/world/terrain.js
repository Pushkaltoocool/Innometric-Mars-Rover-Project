/**
 * Procedural Jezero-crater-like terrain: analytic height function (so the
 * physics, hazard cameras and path planner all agree with the rendered mesh),
 * scattered rocks, an inflated obstacle grid, and an A* planner.
 */

export const WORLD_SIZE = 360; // metres, square, centred on origin
export const GRID_RES = 1; // metres per planner cell

function mulberry32(a) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Value noise with smooth interpolation.
const PERM = new Uint8Array(512);
{
  const r = mulberry32(2020);
  const p = Array.from({ length: 256 }, (_, i) => i);
  for (let i = 255; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [p[i], p[j]] = [p[j], p[i]];
  }
  for (let i = 0; i < 512; i++) PERM[i] = p[i & 255];
}
function hash2(x, y) {
  return PERM[(PERM[x & 255] + y) & 255] / 255;
}
function noise2(x, y) {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;
  const u = xf * xf * (3 - 2 * xf);
  const v = yf * yf * (3 - 2 * yf);
  const a = hash2(xi, yi);
  const b = hash2(xi + 1, yi);
  const c = hash2(xi, yi + 1);
  const d = hash2(xi + 1, yi + 1);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}
function fbm(x, y, oct) {
  let s = 0;
  let amp = 0.5;
  let f = 1;
  for (let i = 0; i < oct; i++) {
    s += amp * noise2(x * f, y * f);
    f *= 2.03;
    amp *= 0.5;
  }
  return s;
}

const rng = mulberry32(42);

// Craters: bowl with raised rim.
export const craters = [];
for (let i = 0; i < 14; i++) {
  const r = 6 + rng() * 18;
  const x = (rng() - 0.5) * (WORLD_SIZE - 60);
  const z = (rng() - 0.5) * (WORLD_SIZE - 60);
  if (Math.hypot(x, z) < 30) continue; // keep the landing site clear
  craters.push({ x, z, r, depth: r * 0.18 });
}

export function heightAt(x, z) {
  let h = (fbm(x * 0.012, z * 0.012, 4) - 0.5) * 14; // rolling plains
  h += (fbm(x * 0.06 + 31, z * 0.06 - 17, 3) - 0.5) * 1.6; // small undulations
  // Distant ridge (crater rim of Jezero) along the edges.
  const edge = Math.max(Math.abs(x), Math.abs(z)) / (WORLD_SIZE / 2);
  h += Math.pow(Math.max(0, edge - 0.62) / 0.38, 2) * 26;
  for (const c of craters) {
    const d = Math.hypot(x - c.x, z - c.z) / c.r;
    if (d < 1.6) {
      if (d < 1) h -= c.depth * (1 - d * d);
      h += c.depth * 0.55 * Math.exp(-Math.pow((d - 1) / 0.22, 2));
    }
  }
  // Flatten the landing zone a bit.
  const L = Math.hypot(x, z);
  if (L < 18) h *= 0.35 + 0.65 * (L / 18);
  return h;
}

export function normalAt(x, z) {
  const e = 0.5;
  const hx = heightAt(x + e, z) - heightAt(x - e, z);
  const hz = heightAt(x, z + e) - heightAt(x, z - e);
  const nx = -hx;
  const ny = 2 * e;
  const nz = -hz;
  const l = Math.hypot(nx, ny, nz);
  return [nx / l, ny / l, nz / l];
}

export function slopeAt(x, z) {
  const n = normalAt(x, z);
  return Math.acos(n[1]); // radians
}

/* ───────────── rocks ───────────── */

export const rocks = [];
function addRock(x, z, r, scripted = false) {
  const rock = { x, z, r, y: heightAt(x, z), seed: Math.floor(rng() * 1e6), scripted };
  rocks.push(rock);
  return rock;
}
for (let i = 0; i < 260; i++) {
  const x = (rng() - 0.5) * (WORLD_SIZE - 30);
  const z = (rng() - 0.5) * (WORLD_SIZE - 30);
  if (Math.hypot(x, z) < 14) continue;
  if (Math.abs(x) < 6 && z > -6 && z < 28) continue; // keep the scenario test range clear
  const big = rng() < 0.12;
  const r = big ? 0.9 + rng() * 1.6 : 0.35 + rng() * 0.5;
  addRock(x, z, r);
}
export { addRock };

/* ───────────── obstacle grid + A* ───────────── */

const N = Math.round(WORLD_SIZE / GRID_RES);
export const grid = new Uint8Array(N * N); // 0 free, 1 obstacle
const ROVER_CLEARANCE = 1.7;

function toCell(v) {
  return Math.max(0, Math.min(N - 1, Math.floor((v + WORLD_SIZE / 2) / GRID_RES)));
}
function cellCenter(i) {
  return (i + 0.5) * GRID_RES - WORLD_SIZE / 2;
}

export function rebuildGrid() {
  grid.fill(0);
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      const x = cellCenter(i);
      const z = cellCenter(j);
      if (slopeAt(x, z) > 0.42 || Math.max(Math.abs(x), Math.abs(z)) > WORLD_SIZE / 2 - 8) grid[j * N + i] = 1;
    }
  }
  for (const r of rocks) stampRock(r);
}
export function stampRock(r) {
  const rad = r.r + ROVER_CLEARANCE;
  const i0 = toCell(r.x - rad);
  const i1 = toCell(r.x + rad);
  const j0 = toCell(r.z - rad);
  const j1 = toCell(r.z + rad);
  for (let j = j0; j <= j1; j++)
    for (let i = i0; i <= i1; i++) {
      if (Math.hypot(cellCenter(i) - r.x, cellCenter(j) - r.z) <= rad) grid[j * N + i] = 1;
    }
}

/**
 * A* on the 8-connected grid. Returns { path: [[x,z],...], expanded }.
 * `expanded` is used to charge CPU time to the Navigation task.
 */
export function planPath(sx, sz, gx, gz, maxExpand = 25000) {
  const s = toCell(sz) * N + toCell(sx);
  let g = toCell(gz) * N + toCell(gx);
  if (grid[g]) {
    // Goal inside an obstacle: snap to nearest free cell.
    let best = -1;
    let bd = Infinity;
    const gi = g % N;
    const gj = (g / N) | 0;
    for (let dj = -6; dj <= 6; dj++)
      for (let di = -6; di <= 6; di++) {
        const i = gi + di;
        const j = gj + dj;
        if (i < 0 || j < 0 || i >= N || j >= N || grid[j * N + i]) continue;
        const d = di * di + dj * dj;
        if (d < bd) {
          bd = d;
          best = j * N + i;
        }
      }
    if (best < 0) return { path: null, expanded: 0 };
    g = best;
  }
  const gi = g % N;
  const gj = (g / N) | 0;
  const h = (c) => {
    const dx = Math.abs((c % N) - gi);
    const dz = Math.abs(((c / N) | 0) - gj);
    return Math.max(dx, dz) + 0.4142 * Math.min(dx, dz);
  };
  const gScore = new Map([[s, 0]]);
  const came = new Map();
  const closed = new Set();
  // binary heap of [f, cell]
  const heap = [[h(s), s]];
  const push = (it) => {
    heap.push(it);
    let i = heap.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (heap[p][0] <= heap[i][0]) break;
      [heap[p], heap[i]] = [heap[i], heap[p]];
      i = p;
    }
  };
  const pop = () => {
    const top = heap[0];
    const last = heap.pop();
    if (heap.length) {
      heap[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < heap.length && heap[l][0] < heap[m][0]) m = l;
        if (r < heap.length && heap[r][0] < heap[m][0]) m = r;
        if (m === i) break;
        [heap[m], heap[i]] = [heap[i], heap[m]];
        i = m;
      }
    }
    return top;
  };
  let expanded = 0;
  const startFree = !grid[s];
  while (heap.length && expanded < maxExpand) {
    const [, c] = pop();
    if (closed.has(c)) continue;
    closed.add(c);
    expanded++;
    if (c === g) {
      const cells = [c];
      let cur = c;
      while (came.has(cur)) {
        cur = came.get(cur);
        cells.push(cur);
      }
      cells.reverse();
      return { path: cells.map((k) => [cellCenter(k % N), cellCenter((k / N) | 0)]), expanded };
    }
    const ci = c % N;
    const cj = (c / N) | 0;
    for (let dj = -1; dj <= 1; dj++)
      for (let di = -1; di <= 1; di++) {
        if (!di && !dj) continue;
        const i = ci + di;
        const j = cj + dj;
        if (i < 0 || j < 0 || i >= N || j >= N) continue;
        const n = j * N + i;
        // Allow escaping if the rover starts inside an inflated zone.
        if (grid[n] && (startFree || closed.size > 40)) continue;
        if (closed.has(n)) continue;
        const step = di && dj ? 1.4142 : 1;
        const ng = gScore.get(c) + step;
        if (ng < (gScore.get(n) ?? Infinity)) {
          gScore.set(n, ng);
          came.set(n, c);
          push([ng + h(n), n]);
        }
      }
  }
  return { path: null, expanded };
}
