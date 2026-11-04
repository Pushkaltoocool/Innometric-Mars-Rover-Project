/**
 * heap_4-style allocator: a single statically sized array, first-fit
 * allocation, block splitting, and coalescing of adjacent free blocks on free.
 * Every block carries an 8-byte header and is 8-byte aligned, as in FreeRTOS.
 */
const HEADER = 8;
const ALIGN = 8;
const MIN_SPLIT = 16;

export class Heap {
  constructor(size) {
    this.size = size;
    this.blocks = [{ addr: 0, size, free: true, owner: null, tag: null }];
    this.minEverFree = size;
    this.allocs = 0;
    this.frees = 0;
    this.fails = 0;
  }

  malloc(bytes, owner, tag) {
    const need = Math.ceil((bytes + HEADER) / ALIGN) * ALIGN;
    for (let i = 0; i < this.blocks.length; i++) {
      const b = this.blocks[i];
      if (!b.free || b.size < need) continue;
      if (b.size - need >= MIN_SPLIT) {
        this.blocks.splice(i + 1, 0, { addr: b.addr + need, size: b.size - need, free: true, owner: null, tag: null });
        b.size = need;
      }
      b.free = false;
      b.owner = owner;
      b.tag = tag;
      b.bornAt = performance.now();
      this.allocs++;
      this.minEverFree = Math.min(this.minEverFree, this.freeBytes());
      return b.addr;
    }
    this.fails++;
    return null;
  }

  free(addr) {
    if (addr === null || addr === undefined) return false;
    const i = this.blocks.findIndex((b) => b.addr === addr && !b.free);
    if (i < 0) return false;
    const b = this.blocks[i];
    b.free = true;
    b.owner = null;
    b.tag = null;
    this.frees++;
    // Coalesce with the next and previous free neighbours.
    const n = this.blocks[i + 1];
    if (n && n.free) {
      b.size += n.size;
      this.blocks.splice(i + 1, 1);
    }
    const p = this.blocks[i - 1];
    if (p && p.free) {
      p.size += b.size;
      this.blocks.splice(i, 1);
    }
    return true;
  }

  freeBytes() {
    let s = 0;
    for (const b of this.blocks) if (b.free) s += b.size;
    return s;
  }

  largestFree() {
    let s = 0;
    for (const b of this.blocks) if (b.free && b.size > s) s = b.size;
    return s;
  }

  /** 0 = one contiguous free region, → 1 = free space shattered into fragments. */
  fragmentation() {
    const f = this.freeBytes();
    return f ? 1 - this.largestFree() / f : 0;
  }

  usedBy() {
    const m = new Map();
    for (const b of this.blocks) if (!b.free) m.set(b.tag ?? '?', (m.get(b.tag ?? '?') ?? 0) + b.size);
    return m;
  }
}
