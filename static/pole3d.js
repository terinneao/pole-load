/*
 * 3D view of the pole, crossarms and dead-end conductors.
 * Rebuilds live from the input form; level force arrows are added after
 * Calculate and removed again as soon as an input changes.
 *
 * Plan convention matches the calculation: x = 0°, y = 90°, counter-clockwise.
 * In three.js (y up) the plan y axis maps to -z.
 */
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { CSS2DRenderer, CSS2DObject } from "three/addons/renderers/CSS2DRenderer.js";

const LEVEL_COLORS = [0xd9480f, 0x2b8a3e, 0x6741d9, 0xc2255c, 0x1971c2, 0xe67700];
const BASE_ANGLES = [0, 90, 180, 270];
const PHASE_SPACING = 0.8;        // m between conductors on a crossarm
const INSULATOR_LEN = 0.3;        // m
const SHORT_SPAN_FACTOR = 2.5;    // shortened spans: max length = factor × pole height
const FORCE_COLOR = 0x0b6bcb;
const POLE_WIND_COLOR = 0x0f9d8a;
const WIND_COLOR = 0x5c7cfa;

const container = document.getElementById("view3d");
const fullSpanBox = document.getElementById("view3d-full");
const resetBtn = document.getElementById("view3d-reset");
const hint = document.getElementById("view3d-status");

const planVec = (deg, len = 1) => {
  const r = (deg * Math.PI) / 180;
  return new THREE.Vector3(Math.cos(r) * len, 0, -Math.sin(r) * len);
};
const pos = (v, fallback) => (Number.isFinite(v) && v > 0 ? v : fallback);
const fmt = v => Number(v).toLocaleString("en-US", { maximumFractionDigits: 0 });
const hex = c => "#" + c.toString(16).padStart(6, "0");

/* ------------------------------------------------------------------ */
/* Scene setup                                                        */
/* ------------------------------------------------------------------ */

container.innerHTML = "";
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(window.devicePixelRatio);
container.appendChild(renderer.domElement);

const labelRenderer = new CSS2DRenderer();
labelRenderer.domElement.className = "v3d-labels";
container.appendChild(labelRenderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0xeef3f8);
scene.add(new THREE.HemisphereLight(0xffffff, 0xb8c4cf, 1.2));
const sun = new THREE.DirectionalLight(0xffffff, 1.5);
sun.position.set(30, 60, 25);
scene.add(sun);

const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 5000);
const controls = new OrbitControls(camera, labelRenderer.domElement);
controls.maxPolarAngle = Math.PI / 2 - 0.02;   // stay above ground
controls.addEventListener("change", render);

let dynamic = null;        // everything rebuilt from the inputs
let results = null;        // {payload, data} from the last Calculate, null when stale
let extent = { poleH: 10, maxR: 20 };
let fitted = false;

function render() {
  renderer.render(scene, camera);
  labelRenderer.render(scene, camera);
}

function resize() {
  const w = container.clientWidth;
  const h = container.clientHeight;
  if (!w || !h) return;
  renderer.setSize(w, h);
  labelRenderer.setSize(w, h);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  render();
}
new ResizeObserver(resize).observe(container);

function fitCamera() {
  const { poleH, maxR } = extent;
  const target = new THREE.Vector3(0, poleH * 0.45, 0);
  const radius = Math.max(Math.hypot(maxR, poleH / 2), poleH * 0.8);
  // use the narrower of the vertical / horizontal field of view
  const vHalf = (camera.fov * Math.PI) / 360;
  const half = Math.min(vHalf, Math.atan(Math.tan(vHalf) * camera.aspect));
  const dist = radius / Math.sin(half);
  const el = (28 * Math.PI) / 180;
  camera.position.copy(target)
    .add(planVec(-55, dist * Math.cos(el)))
    .add(new THREE.Vector3(0, dist * Math.sin(el), 0));
  controls.target.copy(target);
  controls.update();
}

/* ------------------------------------------------------------------ */
/* Builders                                                           */
/* ------------------------------------------------------------------ */

function label(text, cls, color) {
  const outer = document.createElement("div");
  const inner = document.createElement("div");
  inner.className = "v3d-label " + (cls || "");
  inner.textContent = text;
  if (color !== undefined) inner.style.borderLeftColor = hex(color);
  outer.appendChild(inner);
  return new CSS2DObject(outer);
}

function mesh(geometry, color, extra = {}) {
  return new THREE.Mesh(
    geometry,
    new THREE.MeshStandardMaterial({ color, roughness: 0.85, metalness: 0.05, ...extra }),
  );
}

/** Solid arrow (shaft + cone) from origin along dir. */
function arrow(origin, dir, length, color, radius) {
  const g = new THREE.Group();
  const headLen = Math.min(radius * 5, length * 0.45);
  const shaftLen = Math.max(length - headLen, 0.001);
  const shaft = mesh(new THREE.CylinderGeometry(radius, radius, shaftLen, 12), color);
  shaft.position.y = shaftLen / 2;
  const head = mesh(new THREE.ConeGeometry(radius * 2.6, headLen, 16), color);
  head.position.y = shaftLen + headLen / 2;
  g.add(shaft, head);
  g.position.copy(origin);
  g.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.clone().normalize());
  return g;
}

/** Short cylinder between two points. */
function rod(a, b, radius, color, extra) {
  const d = new THREE.Vector3().subVectors(b, a);
  const m = mesh(new THREE.CylinderGeometry(radius, radius, d.length(), 10), color, extra);
  m.position.copy(a).addScaledVector(d, 0.5);
  m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.normalize());
  return m;
}

function disposeGroup(group) {
  group.traverse(o => {
    if (o.isCSS2DObject) o.element.remove();   // CSS2DRenderer leaves nested labels behind
    if (o.geometry) o.geometry.dispose();
    if (o.material) o.material.dispose();
  });
}

function rebuild() {
  if (dynamic) {
    scene.remove(dynamic);
    disposeGroup(dynamic);
  }
  dynamic = new THREE.Group();
  scene.add(dynamic);

  const app = window.poleApp;
  if (!app) return;
  const pay = app.collectPayload();
  const conductorList = app.getConductors();
  const full = fullSpanBox.checked;

  const poleH = pos(pay.pole.height, 10);
  const wTop = pos(pay.pole.width_top, 0.16);
  const wGround = pos(pay.pole.width_ground, 0.3);
  const widthAt = h => wGround + (wTop - wGround) * Math.min(Math.max(h / poleH, 0), 1);

  // sags calculated by the server (auto-sag sides) when results are current
  const calcSag = (li, si) => {
    const sec = results && results.data.sections[li];
    const sd = sec && sec.sides.find(x => x.side_index === si);
    return sd ? sd.sag : null;
  };

  // ---- pole (square, tapered concrete) ----
  const pole = mesh(
    new THREE.CylinderGeometry(wTop / Math.SQRT2, wGround / Math.SQRT2, poleH, 4, 1),
    0xa9b0b7,
    { flatShading: true },
  );
  pole.rotation.y = Math.PI / 4;
  pole.position.y = poleH / 2;
  dynamic.add(pole);
  const poleLabel = label(
    `${pay.pole.size}${pay.pole.count > 1 ? ` ×${pay.pole.count}` : ""} · ${poleH} m`,
    "pole",
  );
  poleLabel.position.set(0, poleH + 0.9, 0);
  dynamic.add(poleLabel);

  // ---- conductor levels ----
  let maxR = poleH * 0.8;
  pay.sections.forEach((sec, li) => {
    const h = sec.height;
    if (!Number.isFinite(h) || h <= 0) return;
    const color = LEVEL_COLORS[li % LEVEL_COLORS.length];
    const lineMat = new THREE.LineBasicMaterial({ color });

    const lvl = label(`L${li + 1} · ${h} m`, "level", color);
    lvl.position.set(0, h, 0);
    lvl.element.firstChild.style.transform = "translateX(-70%)";
    dynamic.add(lvl);

    sec.sides.forEach(sd => {
      if (!sd.enabled) return;
      const dir = BASE_ANGLES[sd.side_index] + (sd.line_angle || 0);
      const u = planVec(dir);
      const v = planVec(dir + 90);
      const n = Math.min(Math.max(sd.count | 0, 1), 12);
      const span = pos(sd.span, 50);
      const sag = calcSag(li, sd.side_index) ?? pos(sd.sag, 1);
      const shown = full ? span : Math.min(span, SHORT_SPAN_FACTOR * poleH);
      const armOff = widthAt(h) / 2 + 0.06;
      const armLen = Math.max(0.6, (n - 1) * PHASE_SPACING + 0.4);
      const base = new THREE.Vector3(0, h, 0).addScaledVector(u, armOff);

      // crossarm, perpendicular to the conductor direction
      const arm = mesh(new THREE.BoxGeometry(armLen, 0.09, 0.09), 0x6b7580);
      arm.position.copy(base);
      arm.rotation.y = ((dir + 90) * Math.PI) / 180;
      dynamic.add(arm);

      for (let k = 0; k < n; k++) {
        const p0 = base.clone().addScaledVector(v, (k - (n - 1) / 2) * PHASE_SPACING);
        const p1 = p0.clone().addScaledVector(u, INSULATOR_LEN);
        dynamic.add(rod(p0, p1, 0.035, 0x8d5524));

        // parabolic sag between equal-height supports
        const pts = [];
        for (let i = 0; i <= 48; i++) {
          const s = i / 48;
          const p = p1.clone().addScaledVector(u, shown * s);
          p.y -= 4 * sag * s * (1 - s);
          pts.push(p);
        }
        dynamic.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), lineMat));
      }

      // far-end dead-end support
      const farR = armOff + INSULATOR_LEN + shown;
      const far = planVec(dir, farR);
      const farPole = mesh(new THREE.CylinderGeometry(0.08, 0.11, h + 0.5, 8), 0xa9b0b7,
        { transparent: true, opacity: 0.55 });
      farPole.position.set(far.x, (h + 0.5) / 2, far.z);
      const farArm = mesh(new THREE.BoxGeometry(armLen, 0.08, 0.08), 0x6b7580,
        { transparent: true, opacity: 0.55 });
      farArm.position.set(far.x, h, far.z);
      farArm.rotation.y = arm.rotation.y;
      dynamic.add(farPole, farArm);
      maxR = Math.max(maxR, farR);

      const c = conductorList.find(x => x.id === sd.conductor_id);
      const name = c ? c.name.replace(/\s*mm2.*$/, "") : "?";
      const cut = shown < span ? " (shortened)" : "";
      const tag = label(
        `L${li + 1} S${sd.side_index + 1} · ${n}× ${name} · ${span} m${cut} · sag ${sag.toFixed(2)} m`,
        "cond", color,
      );
      tag.position.set(far.x, h + 1.0, far.z);
      dynamic.add(tag);
    });
  });

  // ---- ground, grid and plan axes ----
  const step = maxR > 60 ? 10 : maxR > 25 ? 5 : 2;
  const size = Math.ceil(((maxR + 4) * 2) / step) * step;
  const ground = mesh(new THREE.PlaneGeometry(size, size), 0xdde7d5);
  ground.rotation.x = -Math.PI / 2;
  dynamic.add(ground);
  const grid = new THREE.GridHelper(size, size / step, 0xb8c4b0, 0xc9d4c2);
  grid.position.y = 0.01;
  dynamic.add(grid);

  const axisR = Math.max(poleH * 0.6, 4);
  const axisMat = new THREE.LineBasicMaterial({ color: 0x7b8794 });
  [0, 90].forEach(a => {
    const g = new THREE.BufferGeometry().setFromPoints([planVec(a, axisR), planVec(a + 180, axisR)]);
    const line = new THREE.Line(g, axisMat);
    line.position.y = 0.02;
    dynamic.add(line);
  });
  ["0° · S1", "90° · S2", "180° · S3", "270° · S4"].forEach((t, i) => {
    const l = label(t, "axis");
    l.position.copy(planVec(i * 90, axisR + 0.8)).setY(0.05);
    dynamic.add(l);
  });

  // ---- wind direction ----
  const windDeg = Number.isFinite(pay.wind_angle) ? pay.wind_angle : 0;
  const windLen = poleH * 0.45;
  const windStart = planVec(windDeg + 180, windLen + axisR * 0.6).setY(poleH * 1.05);
  dynamic.add(arrow(windStart, planVec(windDeg), windLen, WIND_COLOR, poleH * 0.006 + 0.02));
  const wl = label(`Wind ${pay.wind_pressure} kg/m² → ${windDeg}°`, "wind", WIND_COLOR);
  wl.position.copy(windStart).add(new THREE.Vector3(0, 0.8, 0));
  dynamic.add(wl);

  // ---- force arrows from the last Calculate ----
  if (results) {
    const data = results.data;
    const forces = data.sections.map(s => s.force);
    if (data.pole) forces.push(data.pole.force);
    const maxF = Math.max(...forces, 1e-9);
    const len = f => poleH * (0.12 + 0.4 * f / maxF);
    const r = poleH * 0.006 + 0.03;

    data.sections.forEach(s => {
      if (s.force <= 0) return;
      const d = new THREE.Vector3(s.fx, 0, -s.fy).normalize();
      const o = new THREE.Vector3(0, s.height, 0);
      dynamic.add(arrow(o, d, len(s.force), FORCE_COLOR, r));
      const l = label(`L${s.section}: ${fmt(s.force)} kg @ ${s.direction_deg}°`, "force", FORCE_COLOR);
      l.position.copy(o).addScaledVector(d, len(s.force) + 0.6).add(new THREE.Vector3(0, 0.4, 0));
      dynamic.add(l);
    });

    const p = data.pole;
    if (p && p.force > 0) {
      const d = new THREE.Vector3(p.fx, 0, -p.fy).normalize();
      const o = new THREE.Vector3(0, p.centroid_height, 0);
      dynamic.add(arrow(o, d, len(p.force), POLE_WIND_COLOR, r));
      const l = label(`Pole wind: ${fmt(p.force)} kg`, "force", POLE_WIND_COLOR);
      l.position.copy(o).addScaledVector(d, len(p.force) + 0.6);
      dynamic.add(l);
    }
  }

  hint.textContent = results
    ? "Blue arrows = level resultant forces, teal = wind on pole (from the last Calculate)."
    : "Press Calculate to show force arrows.";

  extent = { poleH, maxR };
  // wait for the first conductors (the form loads asynchronously) before framing
  const hasConductors = pay.sections.some(s => s.sides.some(x => x.enabled));
  if (!fitted && hasConductors) {
    fitCamera();
    fitted = true;
  }
}

/* ------------------------------------------------------------------ */
/* Wiring                                                             */
/* ------------------------------------------------------------------ */

let frame = 0;
function scheduleRebuild() {
  cancelAnimationFrame(frame);
  frame = requestAnimationFrame(() => {
    rebuild();
    render();
  });
}

function onInputsChanged(e) {
  const t = e.target;
  if (t instanceof Element) {
    if (t.closest("#view3d-card") || t.matches("#project-name, #structure-name")) return;
  }
  results = null;                  // force arrows no longer match the inputs
  scheduleRebuild();
}

// capture phase also catches the non-bubbling change event the pole-size select fires
document.addEventListener("input", onInputsChanged, true);
document.addEventListener("change", onInputsChanged, true);
document.addEventListener("pole:inputs-changed", onInputsChanged);
document.addEventListener("pole:calculated", e => {
  results = e.detail;
  scheduleRebuild();
});

fullSpanBox.addEventListener("change", () => {
  fitted = false;
  scheduleRebuild();
});
resetBtn.addEventListener("click", () => {
  fitCamera();
  render();
});

resize();
scheduleRebuild();
