/**
 * three.js presentation layer: Mars terrain, sky, NASA Perseverance model,
 * wheel tracks, dust, AutoNav path, hazcam field-of-view, and cameras.
 * It only *reads* simulation state; it never drives the simulation.
 */
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { WORLD_SIZE, heightAt, normalAt, rocks, slopeAt } from './terrain.js';

const SKY_TOP = new THREE.Color('#6b4a3a');
const SKY_HORIZON = new THREE.Color('#d8a874');
const FOG = new THREE.Color('#c99a6c');

export class MarsScene {
  constructor(container) {
    this.container = container;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    container.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.scene.fog = new THREE.Fog(FOG, 70, 300);
    this.camera = new THREE.PerspectiveCamera(55, 1, 0.1, 2000);
    this.camera.position.set(-7, 4, -9);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.maxPolarAngle = Math.PI * 0.49;
    this.controls.minDistance = 3;
    this.controls.maxDistance = 120;
    this.cameraMode = 'chase';
    this.shake = 0;

    this.roverRoot = new THREE.Group();
    this.roverTilt = new THREE.Group();
    this.roverRoot.add(this.roverTilt);
    this.scene.add(this.roverRoot);
    this._buildSky();
    this._buildLights();
    this._buildTerrain();
    this._buildRocks();
    this._buildTracks();
    this._buildDust();
    this._buildOverlays();
    this.scriptedRockMeshes = new Map();

    this.wheels = [];
    this.loaded = false;

    this.raycaster = new THREE.Raycaster();
    this._resize();
    window.addEventListener('resize', () => this._resize());
  }

  /* ───────────── construction ───────────── */

  _buildSky() {
    const geo = new THREE.SphereGeometry(900, 32, 16);
    const mat = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
      uniforms: {
        top: { value: SKY_TOP },
        horizon: { value: SKY_HORIZON },
        sunDir: { value: new THREE.Vector3(0.45, 0.55, 0.35).normalize() },
      },
      vertexShader: `varying vec3 vDir; void main(){ vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
      fragmentShader: `
        uniform vec3 top; uniform vec3 horizon; uniform vec3 sunDir; varying vec3 vDir;
        void main(){
          float h = clamp(vDir.y, -0.1, 1.0);
          vec3 c = mix(horizon, top, pow(max(h,0.0), 0.55));
          float s = max(dot(normalize(vDir), sunDir), 0.0);
          c += vec3(0.55,0.62,0.75) * pow(s, 60.0) * 0.6;   // Martian blue sunset halo
          c += vec3(1.0,0.95,0.85) * pow(s, 1200.0) * 2.0;  // sun disc
          gl_FragColor = vec4(c, 1.0);
        }`,
    });
    this.sky = new THREE.Mesh(geo, mat);
    this.scene.add(this.sky);

    // Environment map from the sky so the rover's metal parts don't render black.
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    const envScene = new THREE.Scene();
    envScene.add(new THREE.Mesh(geo, mat.clone()));
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(4000, 4000), new THREE.MeshBasicMaterial({ color: '#8a5a3c' }));
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -5;
    envScene.add(ground);
    this.scene.environment = pmrem.fromScene(envScene, 0.04, 0.1, 2000).texture;
  }

  _buildLights() {
    this.scene.add(new THREE.HemisphereLight('#f3c99b', '#5a3020', 0.55));
    const sun = new THREE.DirectionalLight('#fff1dc', 2.6);
    sun.position.set(45, 55, 35);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    const s = sun.shadow.camera;
    s.left = -14;
    s.right = 14;
    s.top = 14;
    s.bottom = -14;
    s.near = 1;
    s.far = 200;
    sun.shadow.bias = -0.0005;
    sun.shadow.normalBias = 0.03;
    this.sun = sun;
    this.scene.add(sun);
    this.scene.add(sun.target);
  }

  _grainTexture() {
    const c = document.createElement('canvas');
    c.width = c.height = 256;
    const g = c.getContext('2d');
    const img = g.createImageData(256, 256);
    for (let i = 0; i < img.data.length; i += 4) {
      const v = 200 + Math.random() * 55;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
      img.data[i + 3] = 255;
    }
    g.putImageData(img, 0, 0);
    // A few pebble speckles.
    for (let i = 0; i < 900; i++) {
      g.fillStyle = `rgba(${60 + Math.random() * 40},${40 + Math.random() * 20},30,${0.25 + Math.random() * 0.4})`;
      g.beginPath();
      g.arc(Math.random() * 256, Math.random() * 256, Math.random() * 1.6, 0, Math.PI * 2);
      g.fill();
    }
    const t = new THREE.CanvasTexture(c);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(WORLD_SIZE / 3, WORLD_SIZE / 3);
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = 8;
    return t;
  }

  _buildTerrain() {
    const seg = 320;
    const geo = new THREE.PlaneGeometry(WORLD_SIZE, WORLD_SIZE, seg, seg);
    geo.rotateX(-Math.PI / 2);
    const pos = geo.attributes.position;
    const colors = new Float32Array(pos.count * 3);
    const dust = new THREE.Color('#c27b4c');
    const dark = new THREE.Color('#6e3f26');
    const pale = new THREE.Color('#d9a273');
    const c = new THREE.Color();
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const z = pos.getZ(i);
      const y = heightAt(x, z);
      pos.setY(i, y);
      const sl = slopeAt(x, z);
      const n = Math.sin(x * 0.11) * Math.cos(z * 0.09) * 0.5 + 0.5;
      c.copy(dust).lerp(pale, n * 0.45).lerp(dark, Math.min(1, sl * 2.2));
      colors[i * 3] = c.r;
      colors[i * 3 + 1] = c.g;
      colors[i * 3 + 2] = c.b;
    }
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geo.computeVertexNormals();
    const mat = new THREE.MeshStandardMaterial({ vertexColors: true, map: this._grainTexture(), roughness: 0.97, metalness: 0 });
    this.terrain = new THREE.Mesh(geo, mat);
    this.terrain.receiveShadow = true;
    this.scene.add(this.terrain);
  }

  _rockGeometry(seed) {
    const g = new THREE.IcosahedronGeometry(1, 2);
    const p = g.attributes.position;
    const v = new THREE.Vector3();
    for (let i = 0; i < p.count; i++) {
      v.fromBufferAttribute(p, i);
      const n = Math.sin(v.x * 3.1 + seed) * Math.cos(v.y * 2.7 + seed * 1.7) * Math.sin(v.z * 3.3 + seed * 0.3);
      const f = 1 + n * 0.28 + Math.sin(v.x * 9 + v.z * 7 + seed) * 0.05;
      v.multiplyScalar(f);
      if (v.y < -0.2) v.y = -0.2 - (v.y + 0.2) * 0.2; // flat-ish base
      p.setXYZ(i, v.x, v.y * 0.72, v.z);
    }
    g.computeVertexNormals();
    return g;
  }

  _buildRocks() {
    const variants = [1.3, 4.1, 7.7, 11.9].map((s) => this._rockGeometry(s));
    this.rockMat = new THREE.MeshStandardMaterial({ color: '#5b3a2a', roughness: 0.9, metalness: 0.02, flatShading: true });
    this.rockVariants = variants;
    const buckets = variants.map(() => []);
    rocks.forEach((r, i) => buckets[i % variants.length].push(r));
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const e = new THREE.Euler();
    buckets.forEach((list, vi) => {
      const inst = new THREE.InstancedMesh(variants[vi], this.rockMat, list.length);
      list.forEach((r, i) => {
        e.set(0, (r.seed % 628) / 100, 0);
        q.setFromEuler(e);
        m.compose(new THREE.Vector3(r.x, r.y + r.r * 0.12, r.z), q, new THREE.Vector3(r.r, r.r, r.r));
        inst.setMatrixAt(i, m);
      });
      inst.castShadow = true;
      inst.receiveShadow = true;
      this.scene.add(inst);
    });
  }

  addScriptedRock(rock) {
    const mesh = new THREE.Mesh(this.rockVariants[1], this.rockMat);
    mesh.position.set(rock.x, rock.y + rock.r * 0.12, rock.z);
    mesh.scale.setScalar(rock.r);
    mesh.castShadow = mesh.receiveShadow = true;
    this.scene.add(mesh);
    this.scriptedRockMeshes.set(rock, mesh);
  }

  removeScriptedRock(rock) {
    const m = this.scriptedRockMeshes.get(rock);
    if (m) this.scene.remove(m);
    this.scriptedRockMeshes.delete(rock);
  }

  _buildTracks() {
    this.trackMax = 6000;
    const geo = new THREE.PlaneGeometry(0.42, 0.62);
    geo.rotateX(-Math.PI / 2);
    const mat = new THREE.MeshStandardMaterial({
      color: '#5a3320',
      roughness: 1,
      transparent: true,
      opacity: 0.45,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -2,
    });
    this.tracks = new THREE.InstancedMesh(geo, mat, this.trackMax);
    this.tracks.count = 0;
    this.tracks.receiveShadow = true;
    this.trackIdx = 0;
    this.trackLast = null;
    this.scene.add(this.tracks);
  }

  _buildDust() {
    const N = 400;
    const geo = new THREE.BufferGeometry();
    this.dustPos = new Float32Array(N * 3);
    this.dustVel = new Float32Array(N * 3);
    this.dustLife = new Float32Array(N);
    geo.setAttribute('position', new THREE.BufferAttribute(this.dustPos, 3));
    const mat = new THREE.PointsMaterial({ color: '#c79466', size: 0.12, transparent: true, opacity: 0.55, depthWrite: false });
    this.dust = new THREE.Points(geo, mat);
    this.dust.frustumCulled = false;
    this.dustN = N;
    this.dustNext = 0;
    this.scene.add(this.dust);
  }

  _buildOverlays() {
    // AutoNav path
    this.pathGeo = new THREE.BufferGeometry();
    this.pathLine = new THREE.Line(this.pathGeo, new THREE.LineBasicMaterial({ color: '#d9c2a0', transparent: true, opacity: 0.9 }));
    this.pathLine.frustumCulled = false;
    this.scene.add(this.pathLine);
    // Waypoint beacon
    const wp = new THREE.Group();
    const ring = new THREE.Mesh(new THREE.RingGeometry(0.9, 1.15, 40), new THREE.MeshBasicMaterial({ color: '#d9c2a0', side: THREE.DoubleSide, transparent: true, opacity: 0.9 }));
    ring.rotation.x = -Math.PI / 2;
    const beam = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 8, 8), new THREE.MeshBasicMaterial({ color: '#d9c2a0', transparent: true, opacity: 0.5 }));
    beam.position.y = 4;
    wp.add(ring, beam);
    wp.visible = false;
    this.waypoint = wp;
    this.scene.add(wp);
    // Hazcam field of view (pulses each time HazardAvoid actually runs)
    const fov = new THREE.Shape();
    fov.moveTo(-1.3, 1.5);
    fov.lineTo(1.3, 1.5);
    fov.lineTo(3.4, 8.5);
    fov.lineTo(-3.4, 8.5);
    fov.closePath();
    const fg = new THREE.ShapeGeometry(fov);
    fg.rotateX(Math.PI / 2);
    this.hazFov = new THREE.Mesh(fg, new THREE.MeshBasicMaterial({ color: '#9fb59a', transparent: true, opacity: 0.18, side: THREE.DoubleSide, depthWrite: false }));
    this.hazFov.position.y = 0.08;
    this.roverRoot.add(this.hazFov);
  }

  /* ───────────── rover model ───────────── */

  async loadRover(url, onProgress) {
    const gltf = await new GLTFLoader().loadAsync(url, (e) => e.total && onProgress?.(e.loaded / e.total));
    const model = gltf.scene;
    model.traverse((o) => {
      if (o.isMesh) {
        o.castShadow = true;
        o.receiveShadow = true;
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        for (const m of mats) if (m.envMapIntensity !== undefined) m.envMapIntensity = 0.9;
      }
    });
    this.roverTilt.add(model);
    this.model = model;
    this.nodes = {};
    model.traverse((o) => {
      if (o.name) this.nodes[o.name] = o;
    });
    const wheelsNode = this.nodes['Wheels_objs'];
    if (wheelsNode) this._splitWheels(wheelsNode);
    this.headRest = this.nodes.head?.quaternion.clone();
    this.hgaRest = this.nodes.antenna_hg?.quaternion.clone();
    this.armNode = this.nodes['arm.002'];
    this.armRest = this.armNode?.quaternion.clone();
    this.loaded = true;
  }

  /** The GLB merges all six wheels into one mesh; split them so they can spin and steer. */
  _splitWheels(node) {
    const meshes = [];
    node.traverse((o) => o.isMesh && meshes.push(o));
    node.updateMatrixWorld(true);
    const pivots = [];
    for (let w = 0; w < 6; w++) {
      const steer = new THREE.Group();
      const spin = new THREE.Group();
      steer.add(spin);
      pivots.push({ steer, spin, box: new THREE.Box3(), parts: [] });
    }
    const bucketOf = (x, z) => (x > 0 ? 0 : 3) + (z > 0.55 ? 0 : z < -0.55 ? 2 : 1);
    for (const mesh of meshes) {
      const src = mesh.geometry.index ? mesh.geometry.toNonIndexed() : mesh.geometry;
      // Bring geometry into the Wheels_objs node's frame.
      const rel = new THREE.Matrix4().copy(node.matrixWorld).invert().multiply(mesh.matrixWorld);
      src.applyMatrix4(rel);
      const pos = src.attributes.position;
      const tris = Array.from({ length: 6 }, () => []);
      for (let t = 0; t < pos.count / 3; t++) {
        const cx = (pos.getX(t * 3) + pos.getX(t * 3 + 1) + pos.getX(t * 3 + 2)) / 3;
        const cz = (pos.getZ(t * 3) + pos.getZ(t * 3 + 1) + pos.getZ(t * 3 + 2)) / 3;
        tris[bucketOf(cx, cz)].push(t);
      }
      tris.forEach((list, w) => {
        if (!list.length) return;
        const g = new THREE.BufferGeometry();
        for (const [name, attr] of Object.entries(src.attributes)) {
          const size = attr.itemSize;
          const arr = new Float32Array(list.length * 3 * size);
          list.forEach((t, i) => {
            for (let v = 0; v < 3; v++)
              for (let c = 0; c < size; c++) arr[(i * 3 + v) * size + c] = attr.getComponent(t * 3 + v, c);
          });
          g.setAttribute(name, new THREE.BufferAttribute(arr, size, attr.normalized));
        }
        g.computeBoundingBox();
        pivots[w].box.union(g.boundingBox);
        pivots[w].parts.push(new THREE.Mesh(g, mesh.material));
      });
      mesh.visible = false;
    }
    pivots.forEach((p, w) => {
      if (!p.parts.length) return;
      const c = new THREE.Vector3();
      p.box.getCenter(c);
      p.steer.position.copy(c);
      for (const m of p.parts) {
        m.geometry.translate(-c.x, -c.y, -c.z);
        m.castShadow = m.receiveShadow = true;
        p.spin.add(m);
      }
      node.add(p.steer);
      const row = w % 3; // 0 front, 1 middle, 2 rear
      this.wheels.push({ ...p, row });
    });
  }

  /* ───────────── per-frame sync ───────────── */

  update(dt, rover, sys, k, ui) {
    // Rover pose
    this.roverRoot.position.set(rover.x, rover.y, rover.z);
    this.roverRoot.rotation.set(0, rover.yaw, 0);
    this.roverTilt.rotation.set(-rover.pitch, 0, rover.roll, 'YXZ');
    for (const w of this.wheels) {
      w.spin.rotation.x = rover.wheelAngle;
      const steer = rover.target.steer * 0.45 * (Math.abs(rover.v) < 0.3 ? 1.6 : 1);
      w.steer.rotation.y = w.row === 0 ? steer : w.row === 2 ? -steer : 0;
    }

    const now = k.tick;
    // Mastcam head pans while imaging, HGA tracks Earth while transmitting.
    if (this.nodes?.head && this.headRest) {
      const busy = now - sys.mastBusy < 900;
      this._panTarget = busy ? Math.sin(now / 300) * 0.6 : 0;
      this._pan = THREE.MathUtils.lerp(this._pan ?? 0, this._panTarget, Math.min(1, dt * 3));
      this.nodes.head.quaternion.copy(this.headRest).premultiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), this._pan));
    }
    if (this.nodes?.antenna_hg && this.hgaRest) {
      const tx = now - sys.hgaBusy < 400;
      this._hga = THREE.MathUtils.lerp(this._hga ?? 0, tx ? 0.9 : 0, Math.min(1, dt * 2));
      this.nodes.antenna_hg.quaternion.copy(this.hgaRest).premultiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), this._hga));
    }
    if (this.armNode && this.armRest) {
      const target = sys.armPhase === 'deploy' || sys.armPhase === 'drill' ? 1 : 0;
      this._arm = THREE.MathUtils.lerp(this._arm ?? 0, target, Math.min(1, dt * 1.5));
      const jitter = sys.armPhase === 'drill' ? Math.sin(performance.now() / 25) * 0.01 : 0;
      this.armNode.quaternion.copy(this.armRest).multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), this._arm * 0.7 + jitter));
    }

    // Hazcam FOV: brightens on each fresh scan, dims when HazardAvoid is starved.
    const age = now - sys.lastHazardScan;
    const fresh = Math.max(0, 1 - age / 120);
    this.hazFov.material.color.set(sys.hazardAhead ? '#e86a55' : age > 400 ? '#e3a646' : '#9fb59a');
    this.hazFov.material.opacity = 0.06 + fresh * 0.22 + (age > 400 ? 0.1 * (0.5 + 0.5 * Math.sin(performance.now() / 90)) : 0);
    this.hazFov.rotation.y = sys.hazardDir < 0 ? Math.PI : 0;
    this.hazFov.visible = ui.showFov;

    this._updateTracks(rover);
    this._updateDust(dt, rover);
    this._updatePath(sys);
    this._updateCamera(dt, rover);

    // Shadow camera follows the rover.
    this.sun.position.set(rover.x + 45, rover.y + 55, rover.z + 35);
    this.sun.target.position.set(rover.x, rover.y, rover.z);

    this.renderer.render(this.scene, this.camera);
  }

  _updateTracks(rover) {
    const p = [rover.x, rover.z];
    if (this.trackLast && Math.hypot(p[0] - this.trackLast[0], p[1] - this.trackLast[1]) < 0.55) return;
    if (!this.trackLast) {
      this.trackLast = p;
      return;
    }
    this.trackLast = p;
    const m = new THREE.Matrix4();
    const rx = Math.cos(rover.yaw);
    const rz = -Math.sin(rover.yaw);
    for (const side of [-1, 1]) {
      const x = rover.x + rx * side * 1.2;
      const z = rover.z + rz * side * 1.2;
      const n = normalAt(x, z);
      const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), new THREE.Vector3(...n));
      q.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), rover.yaw));
      m.compose(new THREE.Vector3(x, heightAt(x, z) + 0.03, z), q, new THREE.Vector3(1, 1, 1));
      this.tracks.setMatrixAt(this.trackIdx, m);
      this.trackIdx = (this.trackIdx + 1) % this.trackMax;
      this.tracks.count = Math.min(this.trackMax, this.tracks.count + 1);
    }
    this.tracks.instanceMatrix.needsUpdate = true;
  }

  _updateDust(dt, rover) {
    const speed = Math.abs(rover.v);
    if (speed > 0.25) {
      const n = Math.ceil(speed * 3);
      const rx = Math.cos(rover.yaw);
      const rz = -Math.sin(rover.yaw);
      const fx = Math.sin(rover.yaw) * Math.sign(rover.v);
      const fz = Math.cos(rover.yaw) * Math.sign(rover.v);
      for (let i = 0; i < n; i++) {
        const j = this.dustNext;
        this.dustNext = (j + 1) % this.dustN;
        const side = Math.random() < 0.5 ? -1 : 1;
        const back = -1.1 - Math.random() * 0.4;
        this.dustPos[j * 3] = rover.x + rx * side * 1.2 + fx * back;
        this.dustPos[j * 3 + 1] = rover.y + 0.1;
        this.dustPos[j * 3 + 2] = rover.z + rz * side * 1.2 + fz * back;
        this.dustVel[j * 3] = (Math.random() - 0.5) * 0.6 - fx * 0.4;
        this.dustVel[j * 3 + 1] = 0.3 + Math.random() * 0.5;
        this.dustVel[j * 3 + 2] = (Math.random() - 0.5) * 0.6 - fz * 0.4;
        this.dustLife[j] = 1.6;
      }
    }
    for (let j = 0; j < this.dustN; j++) {
      if (this.dustLife[j] <= 0) {
        this.dustPos[j * 3 + 1] = -1e4;
        continue;
      }
      this.dustLife[j] -= dt;
      this.dustVel[j * 3 + 1] -= 0.37 * dt; // Mars gravity (scaled)
      this.dustPos[j * 3] += this.dustVel[j * 3] * dt;
      this.dustPos[j * 3 + 1] += this.dustVel[j * 3 + 1] * dt;
      this.dustPos[j * 3 + 2] += this.dustVel[j * 3 + 2] * dt;
    }
    this.dust.geometry.attributes.position.needsUpdate = true;
  }

  _updatePath(sys) {
    const path = sys.mode === 'autonav' ? sys.path : null;
    if (path !== this._lastPath) {
      this._lastPath = path;
      if (path) {
        const arr = new Float32Array(path.length * 3);
        path.forEach(([x, z], i) => {
          arr[i * 3] = x;
          arr[i * 3 + 1] = heightAt(x, z) + 0.15;
          arr[i * 3 + 2] = z;
        });
        this.pathGeo.setAttribute('position', new THREE.BufferAttribute(arr, 3));
        this.pathGeo.setDrawRange(0, path.length);
      } else this.pathGeo.setDrawRange(0, 0);
    }
    const wp = sys.waypoint;
    this.waypoint.visible = !!wp;
    if (wp) {
      this.waypoint.position.set(wp.x, heightAt(wp.x, wp.z) + 0.05, wp.z);
      this.waypoint.children[0].scale.setScalar(1 + 0.15 * Math.sin(performance.now() / 200));
    }
  }

  setCameraMode(mode) {
    this.cameraMode = mode;
    this.controls.enabled = mode === 'orbit';
    if (mode === 'orbit') {
      this.controls.target.set(this.roverRoot.position.x, this.roverRoot.position.y + 1, this.roverRoot.position.z);
    }
  }

  _updateCamera(dt, rover) {
    const cam = this.camera;
    const tgt = new THREE.Vector3(rover.x, rover.y + 1.1, rover.z);
    const fx = Math.sin(rover.yaw);
    const fz = Math.cos(rover.yaw);
    if (this.cameraMode === 'chase') {
      const want = new THREE.Vector3(rover.x - fx * 8.5, 0, rover.z - fz * 8.5);
      want.y = Math.max(heightAt(want.x, want.z) + 1.5, rover.y + 3.6);
      cam.position.lerp(want, Math.min(1, dt * 2.5));
      cam.lookAt(tgt);
    } else if (this.cameraMode === 'orbit') {
      const prev = this._prevTarget ?? tgt.clone();
      const delta = tgt.clone().sub(prev);
      cam.position.add(delta);
      this.controls.target.add(delta);
      this.controls.update();
    } else if (this.cameraMode === 'mastcam') {
      const head = this.nodes?.head;
      if (head) {
        head.getWorldPosition(cam.position);
        cam.position.y += 0.1;
        const dir = new THREE.Vector3(Math.sin(rover.yaw + (this._pan ?? 0)), -0.12, Math.cos(rover.yaw + (this._pan ?? 0)));
        cam.lookAt(cam.position.clone().add(dir));
      }
    } else if (this.cameraMode === 'top') {
      const want = new THREE.Vector3(rover.x, rover.y + 55, rover.z - 0.01);
      cam.position.lerp(want, Math.min(1, dt * 3));
      cam.lookAt(tgt);
    }
    this._prevTarget = tgt;
    if (this.shake > 0) {
      this.shake = Math.max(0, this.shake - dt);
      const a = this.shake * 0.25;
      cam.position.x += (Math.random() - 0.5) * a;
      cam.position.y += (Math.random() - 0.5) * a;
    }
  }

  /** Terrain point under a screen pixel (for AutoNav goals). */
  pick(clientX, clientY) {
    const r = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    const hit = this.raycaster.intersectObject(this.terrain, false)[0];
    return hit ? hit.point : null;
  }

  _resize() {
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }
}
