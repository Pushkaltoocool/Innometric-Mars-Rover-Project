/**
 * The physical rover ("plant") that the RTOS tasks sense and control.
 * Only the MotorCtrl task writes actuator set-points; only HazardAvoid reads the
 * hazard cameras. If those tasks are starved, the rover really does keep
 * driving on stale commands — scheduling decisions have physical consequences.
 */
import { heightAt, rocks, normalAt } from './terrain.js';

export const ROVER = {
  halfWidth: 1.35,
  halfLength: 1.45,
  wheelRadius: 0.2625,
  maxSpeed: 2.4, // m/s demo speed (real Perseverance: ~0.042 m/s)
  accel: 1.6,
  maxYawRate: 0.75, // rad/s, Perseverance can turn in place
};

export class RoverSim {
  constructor() {
    this.x = 0;
    this.z = 0;
    this.yaw = 0;
    this.v = 0;
    this.yawRate = 0;
    this.target = { speed: 0, steer: 0 };
    this.lastActuation = 0;
    this.odometer = 0;
    this.wheelAngle = 0;
    this.collisions = 0;
    this.crash = null; // { at, rock }
    this.listeners = { collision: [] };
    this.pitch = 0;
    this.roll = 0;
    this.y = heightAt(0, 0);
    this.powerDraw = 0;
    this.trail = [];
  }

  on(evt, fn) {
    this.listeners[evt].push(fn);
  }

  /** Actuator interface (called by MotorCtrl only). */
  setActuators(speed, steer, tick) {
    this.target.speed = speed;
    this.target.steer = steer;
    this.lastActuation = tick;
  }

  forward() {
    return [Math.sin(this.yaw), Math.cos(this.yaw)];
  }

  /**
   * Hazard-camera scan: free distance (m) to the nearest rock in the
   * direction of travel (dir = +1 forward, -1 reverse) within the swept width.
   */
  hazcamScan(dir = 1, range = 12) {
    const [fx, fz] = this.forward();
    let best = range;
    for (const r of rocks) {
      const dx = r.x - this.x;
      const dz = r.z - this.z;
      if (Math.abs(dx) > range + 3 || Math.abs(dz) > range + 3) continue;
      const along = (dx * fx + dz * fz) * dir;
      const lat = Math.abs(dx * fz - dz * fx);
      if (along <= 0 || lat > r.r + ROVER.halfWidth + 0.15) continue;
      const free = along - r.r - ROVER.halfLength;
      if (free < best) best = Math.max(0, free);
    }
    return best;
  }

  update(dt, tick) {
    // Speed tracks the set-point with an acceleration limit.
    const dv = this.target.speed - this.v;
    const maxDv = ROVER.accel * dt;
    this.v += Math.max(-maxDv, Math.min(maxDv, dv));
    // Slope resistance.
    const [fx, fz] = this.forward();
    const ahead = heightAt(this.x + fx, this.z + fz) - heightAt(this.x - fx, this.z - fz);
    const grade = ahead / 2;
    if (this.v > 0 && grade > 0) this.v *= 1 - Math.min(0.5, grade * 1.5) * dt;

    const yr = this.target.steer * ROVER.maxYawRate;
    this.yawRate += (yr - this.yawRate) * Math.min(1, dt * 6);
    this.yaw += this.yawRate * dt;

    let nx = this.x + Math.sin(this.yaw) * this.v * dt;
    let nz = this.z + Math.cos(this.yaw) * this.v * dt;

    // Collision with rocks (rover footprint approximated as a circle).
    for (const r of rocks) {
      const dx = nx - r.x;
      const dz = nz - r.z;
      const minD = r.r + ROVER.halfLength * 0.92;
      const d2 = dx * dx + dz * dz;
      if (d2 < minD * minD) {
        const d = Math.sqrt(d2) || 0.001;
        nx = r.x + (dx / d) * minD;
        nz = r.z + (dz / d) * minD;
        if (Math.abs(this.v) > 0.25 && (!this.crash || tick - this.crash.at > 1500)) {
          this.collisions++;
          this.crash = { at: tick, rock: r, speed: Math.abs(this.v) };
          for (const fn of this.listeners.collision) fn(this.crash);
        }
        this.v = 0;
      }
    }
    const moved = Math.hypot(nx - this.x, nz - this.z);
    this.odometer += moved;
    this.wheelAngle += (this.v * dt) / ROVER.wheelRadius;
    this.x = nx;
    this.z = nz;

    // Sit the rover on the terrain: sample under the wheel footprint.
    const [sx, sz] = [Math.cos(this.yaw), -Math.sin(this.yaw)]; // right vector
    const L = ROVER.halfLength * 0.8;
    const W = ROVER.halfWidth * 0.8;
    const hf = heightAt(this.x + fx * L, this.z + fz * L);
    const hb = heightAt(this.x - fx * L, this.z - fz * L);
    const hr = heightAt(this.x + sx * W, this.z + sz * W);
    const hl = heightAt(this.x - sx * W, this.z - sz * W);
    this.y = (hf + hb + hr + hl) / 4;
    this.pitch = Math.atan2(hf - hb, 2 * L);
    this.roll = Math.atan2(hr - hl, 2 * W);

    // Electrical draw (W): avionics + mobility.
    this.powerDraw = 70 + Math.abs(this.v) * 55 + Math.abs(this.yawRate) * 30;

    if (moved > 0 && (!this.trail.length || Math.hypot(...[this.x - this.trail.at(-1)[0], this.z - this.trail.at(-1)[1]]) > 0.6)) {
      this.trail.push([this.x, this.z, this.yaw]);
      if (this.trail.length > 2000) this.trail.shift();
    }
  }

  slope() {
    const n = normalAt(this.x, this.z);
    return Math.acos(n[1]);
  }
}
