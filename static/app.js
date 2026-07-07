"use strict";

const SIDE_NAMES = ["Side 1 (0\u00B0)", "Side 2 (90\u00B0)", "Side 3 (180\u00B0)", "Side 4 (270\u00B0)"];

let conductors = [];
let poles = [];
let lastPayload = null;
let lastData = null;

const el = (sel, root = document) => root.querySelector(sel);
const els = (sel, root = document) => [...root.querySelectorAll(sel)];

/* ------------------------------------------------------------------ */
/* Section / side construction                                        */
/* ------------------------------------------------------------------ */

function buildConductorOptions(select) {
  select.innerHTML = "";
  for (const c of conductors) {
    const opt = document.createElement("option");
    opt.value = c.id;
    opt.textContent = `${c.name}  (\u2300${c.diameter_mm} mm, ${c.weight_kg_per_m} kg/m)`;
    select.appendChild(opt);
  }
}

function addSection() {
  const tpl = el("#section-template").content.cloneNode(true);
  const card = tpl.querySelector(".section-card");
  const sidesBox = card.querySelector(".sides");

  for (let i = 0; i < 4; i++) {
    const sideTpl = el("#side-template").content.cloneNode(true);
    const side = sideTpl.querySelector(".side");
    side.dataset.sideIndex = i;
    side.querySelector(".side-name").textContent = SIDE_NAMES[i];
    buildConductorOptions(side.querySelector(".conductor"));
    const chk = side.querySelector(".enabled");
    chk.addEventListener("change", () => side.classList.toggle("on", chk.checked));
    const sag = side.querySelector(".sag");
    sag.addEventListener("change", () => {
      const v = parseFloat(sag.value);
      if (!isNaN(v)) sag.value = v.toFixed(2);
    });
    // sides 3 & 4 can auto-calculate their sag to match sides 1 & 2 tension
    if (i >= 2) {
      const toggle = side.querySelector(".balance-toggle");
      toggle.hidden = false;
      side.querySelector(".balance-label").textContent =
        `Auto sag: equalize tension with Side ${i - 1}`;
      const balance = side.querySelector(".balance");
      balance.addEventListener("change", () => {
        sag.disabled = balance.checked;
      });
    }
    sidesBox.appendChild(sideTpl);
  }

  card.querySelector(".remove-section").addEventListener("click", () => {
    card.remove();
    renumberSections();
  });

  el("#sections").appendChild(tpl);
  renumberSections();
}

function renumberSections() {
  els(".section-card").forEach((card, i) => {
    card.querySelector(".section-title").textContent = `Level ${i + 1}`;
  });
}

/* ------------------------------------------------------------------ */
/* Payload & API                                                      */
/* ------------------------------------------------------------------ */

function collectPayload() {
  const sections = els(".section-card").map(card => ({
    height: parseFloat(el(".height", card).value),
    sides: els(".side", card).map(side => ({
      side_index: parseInt(side.dataset.sideIndex, 10),
      enabled: el(".enabled", side).checked,
      conductor_id: parseInt(el(".conductor", side).value, 10),
      count: parseInt(el(".count", side).value, 10),
      span: parseFloat(el(".span", side).value),
      sag: parseFloat(el(".sag", side).value),
      balance: el(".balance", side).checked,
      line_angle: parseFloat(el(".line-angle", side).value) || 0,
    })),
  }));

  return {
    project_name: el("#project-name").value.trim(),
    structure_name: el("#structure-name").value.trim(),
    wind_pressure: parseFloat(el("#wind-pressure").value),
    wind_angle: parseFloat(el("#wind-angle").value),
    pole: {
      size: el("#pole-size").selectedOptions[0]?.value
        ? el("#pole-size").selectedOptions[0].textContent.split("  (")[0]
        : "Custom",
      count: parseInt(el("#pole-count").value, 10) || 1,
      wind_pressure: parseFloat(el("#pole-wind-pressure").value) || 0,
      height: parseFloat(el("#pole-height").value) || 0,
      width_top: parseFloat(el("#pole-width-top").value) || 0,
      width_ground: parseFloat(el("#pole-width-ground").value) || 0,
      drag_coefficient: parseFloat(el("#pole-cd").value) || 1,
      strength: parseFloat(el("#pole-strength").value) || 0,
    },
    sections,
  };
}

async function calculate() {
  const errBox = el("#error");
  errBox.hidden = true;

  const payload = collectPayload();
  if (payload.sections.length === 0) {
    return showError("Add at least one conductor level.");
  }
  if (!payload.sections.some(s => s.sides.some(x => x.enabled))) {
    return showError("Enable at least one conductor side.");
  }

  try {
    const res = await fetch("/api/calculate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Calculation failed");
    lastPayload = payload;
    lastData = data;
    renderResults(data);
    el("#print-btn").hidden = false;
  } catch (e) {
    showError(e.message);
  }
}

function showError(msg) {
  const errBox = el("#error");
  errBox.textContent = msg;
  errBox.hidden = false;
}

/* ------------------------------------------------------------------ */
/* Rendering                                                          */
/* ------------------------------------------------------------------ */

const fmt = (v, dec = 1) =>
  Number(v).toLocaleString("en-US", { minimumFractionDigits: dec, maximumFractionDigits: dec });

const escapeHtml = str => str.replace(/[&<>"']/g,
  ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));

function renderResults(data) {
  el("#results-empty").hidden = true;
  el("#results").hidden = false;

  const s = data.summary;
  el("#summary").innerHTML = `
    <div class="summary-item"><div class="val">${fmt(s.resultant_force)} kg</div>
      <div class="lbl">Resultant horizontal force @ ${fmt(s.force_direction_deg)}\u00B0</div></div>
    <div class="summary-item"><div class="val">${fmt(s.groundline_moment)} kg\u00B7m</div>
      <div class="lbl">Resultant bending moment at ground line</div></div>
    <div class="summary-item"><div class="val">${fmt(s.total_vertical_load)} kg</div>
      <div class="lbl">Total vertical load</div></div>
    ${!data.strength_check ? "" : `
    <div class="summary-item ${data.strength_check.ok ? "check-ok" : "check-fail"}">
      <div class="val">${fmt(data.strength_check.utilization_pct)} %
        ${data.strength_check.ok ? "OK" : "OVERLOADED"}</div>
      <div class="lbl">Moment vs pole strength
        (${fmt(data.strength_check.capacity)} kg\u00B7m capacity)</div></div>`}`;

  el("#direction-summary").innerHTML = `
    <table>
      <thead><tr>
        <th>Direction</th><th>Force (kg)</th><th>Moment @ ground (kg\u00B7m)</th>
      </tr></thead>
      <tbody>
        <tr><td>X axis (0\u00B0 \u2013 180\u00B0)</td><td>${fmt(s.fx)}</td><td>${fmt(s.moment_x)}</td></tr>
        <tr><td>Y axis (90\u00B0 \u2013 270\u00B0)</td><td>${fmt(s.fy)}</td><td>${fmt(s.moment_y)}</td></tr>
        <tr class="total-row"><td>Resultant</td><td>${fmt(s.resultant_force)}</td><td>${fmt(s.groundline_moment)}</td></tr>
      </tbody>
    </table>
    <p class="hint">Positive = toward 0\u00B0 (X) or 90\u00B0 (Y); negative = opposite side.
      Moments are about the perpendicular axis at the ground line.</p>`;

  el("#plan-view").innerHTML = planViewSVG(s.force_direction_deg, s.resultant_force);

  const p = data.pole;
  const poleHtml = !p || p.force === 0 ? "" : `
    <div class="section-result">
      <h3>Wind on pole shaft &mdash; ${p.size}</h3>
      <p class="sub">${p.count} pole(s) &middot; height ${fmt(p.height, 2)} m &middot;
        width ${fmt(p.width_top, 2)}&ndash;${fmt(p.width_ground, 2)} m &middot;
        C<sub>d</sub> = ${fmt(p.drag_coefficient, 2)} &middot;
        projected area ${fmt(p.area, 2)} m&sup2; &middot;
        wind pressure ${fmt(p.wind_pressure)} kg/m&sup2;</p>
      <p class="sec-totals">
        Force: <b>${fmt(p.force)} kg</b> @ ${fmt(p.direction_deg)}\u00B0 (wind direction)
        &nbsp;&middot;&nbsp; applied at <b>${fmt(p.centroid_height, 2)} m</b>
        &nbsp;&middot;&nbsp; Moment @ ground: <b>${fmt(p.moment)} kg\u00B7m</b><br>
        Force X: <b>${fmt(p.fx)} kg</b> &nbsp;&middot;&nbsp; Force Y: <b>${fmt(p.fy)} kg</b>
        &nbsp;&middot;&nbsp; Moment X: <b>${fmt(p.moment_x)} kg\u00B7m</b>
        &nbsp;&middot;&nbsp; Moment Y: <b>${fmt(p.moment_y)} kg\u00B7m</b></p>
    </div>`;

  el("#section-results").innerHTML = poleHtml + data.sections.map(sec => `
    <div class="section-result">
      <h3>Level ${sec.section} &mdash; height ${fmt(sec.height, 2)} m</h3>
      ${sec.sides.length === 0 ? '<p class="sub">No conductors enabled.</p>' : `
      <table>
        <thead><tr>
          <th>Side</th><th>Conductor</th><th>n</th>
          <th>w<sub>res</sub> (kg/m)</th><th>Sag (m)</th><th>T/cond (kg)</th>
          <th>Pull (kg)</th><th>Wind (kg)</th><th>Vert. (kg)</th>
        </tr></thead>
        <tbody>
          ${sec.sides.map(sd => `
          <tr>
            <td>${sd.side_name}${sd.direction_deg !== null ? ` @ ${fmt(sd.direction_deg)}\u00B0` : ""}</td>
            <td>${sd.conductor}</td>
            <td>${sd.count}</td>
            <td>${fmt(sd.resultant_unit_weight, 3)}</td>
            <td>${fmt(sd.sag, 2)}${sd.sag_auto ? " *" : ""}</td>
            <td>${fmt(sd.tension_per_conductor)}</td>
            <td>${fmt(sd.tension_total)}</td>
            <td>${fmt(sd.wind_force)}</td>
            <td>${fmt(sd.vertical_load)}</td>
          </tr>`).join("")}
        </tbody>
      </table>
      ${sec.sides.some(sd => sd.sag_auto)
        ? '<p class="hint">* sag calculated to equalize tension with the opposite side.</p>' : ""}
      <p class="sec-totals">
        Force X: <b>${fmt(sec.fx)} kg</b> &nbsp;&middot;&nbsp; Force Y: <b>${fmt(sec.fy)} kg</b>
        &nbsp;&middot;&nbsp; Moment X: <b>${fmt(sec.moment_x)} kg\u00B7m</b>
        &nbsp;&middot;&nbsp; Moment Y: <b>${fmt(sec.moment_y)} kg\u00B7m</b><br>
        Level resultant: <b>${fmt(sec.force)} kg</b> @ ${fmt(sec.direction_deg)}\u00B0
        &nbsp;&middot;&nbsp; Moment @ ground: <b>${fmt(sec.moment)} kg\u00B7m</b>
        &nbsp;&middot;&nbsp; Vertical: <b>${fmt(sec.vertical_load)} kg</b></p>
      <div class="level-plan">${levelPlanSVG(sec)}
        <p class="hint">Green = conductors (with count), blue arrow = level resultant force.</p>
      </div>`}
    </div>`).join("");
}

function levelPlanSVG(sec) {
  const cx = 120, cy = 120, r = 78;

  const conductorLines = sec.sides.map(sd => {
    const rad = sd.direction_deg * Math.PI / 180;
    const x2 = cx + r * Math.cos(rad);
    const y2 = cy - r * Math.sin(rad);
    const lx = cx + (r + 16) * Math.cos(rad);
    const ly = cy - (r + 16) * Math.sin(rad) + 3;
    const label = `${sd.count}\u00D7${sd.conductor.replace(/\s*mm2.*$/, "")}`;
    return `
      <line x1="${cx}" y1="${cy}" x2="${x2}" y2="${y2}"
            stroke="#157347" stroke-width="2.5"/>
      <circle cx="${x2}" cy="${y2}" r="3" fill="#157347"/>
      <text x="${lx}" y="${ly}" font-size="9.5" fill="#157347"
            text-anchor="middle" font-weight="600">${label}</text>`;
  }).join("");

  let resultantArrow = "";
  if (sec.force > 0) {
    const rad = sec.direction_deg * Math.PI / 180;
    const len = r * 0.55;
    const x2 = cx + len * Math.cos(rad);
    const y2 = cy - len * Math.sin(rad);
    resultantArrow = `
      <defs><marker id="arr-l${sec.section}" markerWidth="8" markerHeight="8"
        refX="6" refY="3" orient="auto"><path d="M0,0 L6,3 L0,6 z" fill="#0b6bcb"/></marker></defs>
      <line x1="${cx}" y1="${cy}" x2="${x2}" y2="${y2}" stroke="#0b6bcb"
            stroke-width="3" marker-end="url(#arr-l${sec.section})"/>`;
  }

  return `
  <svg viewBox="0 0 240 250" xmlns="http://www.w3.org/2000/svg">
    <circle cx="${cx}" cy="${cy}" r="${r}" fill="#f6f9fc" stroke="#dde4ec"/>
    <line x1="${cx - r}" y1="${cy}" x2="${cx + r}" y2="${cy}" stroke="#dde4ec" stroke-dasharray="3 3"/>
    <line x1="${cx}" y1="${cy - r}" x2="${cx}" y2="${cy + r}" stroke="#dde4ec" stroke-dasharray="3 3"/>
    <text x="${cx + r + 4}" y="${cy + 3}" font-size="9" fill="#94a3b8">0\u00B0</text>
    <text x="${cx - 7}" y="${cy - r - 4}" font-size="9" fill="#94a3b8">90\u00B0</text>
    <text x="${cx - r - 22}" y="${cy + 3}" font-size="9" fill="#94a3b8">180\u00B0</text>
    <text x="${cx - 10}" y="${cy + r + 11}" font-size="9" fill="#94a3b8">270\u00B0</text>
    ${conductorLines}
    ${resultantArrow}
    <circle cx="${cx}" cy="${cy}" r="7" fill="#1c2733"/>
    <text x="${cx}" y="246" font-size="10" fill="#64748b" text-anchor="middle">
      Level ${sec.section} \u2014 plan view</text>
  </svg>`;
}

function planViewSVG(angleDeg, force) {
  const cx = 120, cy = 120, r = 90;
  const rad = angleDeg * Math.PI / 180;
  // screen y is inverted relative to math convention
  const x2 = cx + r * Math.cos(rad);
  const y2 = cy - r * Math.sin(rad);
  return `
  <svg viewBox="0 0 240 240" xmlns="http://www.w3.org/2000/svg">
    <circle cx="${cx}" cy="${cy}" r="${r + 8}" fill="#f6f9fc" stroke="#dde4ec"/>
    <line x1="${cx - r}" y1="${cy}" x2="${cx + r}" y2="${cy}" stroke="#dde4ec"/>
    <line x1="${cx}" y1="${cy - r}" x2="${cx}" y2="${cy + r}" stroke="#dde4ec"/>
    <text x="${cx + r + 2}" y="${cy + 4}" font-size="10" fill="#64748b">0\u00B0</text>
    <text x="${cx - 8}" y="${cy - r - 2}" font-size="10" fill="#64748b">90\u00B0</text>
    <text x="${cx - r - 24}" y="${cy + 4}" font-size="10" fill="#64748b">180\u00B0</text>
    <text x="${cx - 12}" y="${cy + r + 12}" font-size="10" fill="#64748b">270\u00B0</text>
    ${force > 0 ? `
    <defs><marker id="arr" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto">
      <path d="M0,0 L6,3 L0,6 z" fill="#0b6bcb"/></marker></defs>
    <line x1="${cx}" y1="${cy}" x2="${x2}" y2="${y2}" stroke="#0b6bcb" stroke-width="3" marker-end="url(#arr)"/>` : ""}
    <circle cx="${cx}" cy="${cy}" r="6" fill="#1c2733"/>
    <text x="${cx}" y="232" font-size="11" fill="#64748b" text-anchor="middle">Plan view \u2014 resultant force direction</text>
  </svg>`;
}

/* ------------------------------------------------------------------ */
/* Print calculation sheet                                            */
/* ------------------------------------------------------------------ */

function printSheet() {
  if (!lastPayload || !lastData) return;
  const pay = lastPayload;
  const data = lastData;
  const s = data.summary;
  const p = data.pole;
  const now = new Date();

  const inputsTable = pay.sections.map((sec, i) => {
    const enabled = sec.sides.filter(x => x.enabled);
    return enabled.map((sd, j) => {
      const c = conductors.find(x => x.id === sd.conductor_id);
      return `<tr>
        ${j === 0 ? `<td rowspan="${enabled.length}">Level ${i + 1}</td>
                     <td rowspan="${enabled.length}">${fmt(sec.height, 2)}</td>` : ""}
        <td>${SIDE_NAMES[sd.side_index]}</td>
        <td>${c ? c.name : sd.conductor_id}</td>
        <td>${c ? fmt(c.diameter_mm, 2) : "-"}</td>
        <td>${c ? fmt(c.weight_kg_per_m, 3) : "-"}</td>
        <td>${sd.count}</td>
        <td>${fmt(sd.span, 1)}</td>
        <td>${sd.balance ? "auto" : fmt(sd.sag, 2)}</td>
        <td>${fmt(sd.line_angle, 1)}</td>
      </tr>`;
    }).join("");
  }).join("");

  const poleResultHtml = !p || p.force === 0 ? "" : `
    <h3>3.1 Wind on pole shaft</h3>
    <table>
      <thead><tr><th>Projected area (m&sup2;)</th><th>Force (kg)</th>
        <th>Direction (&deg;)</th><th>Applied at (m)</th>
        <th>Force X (kg)</th><th>Force Y (kg)</th>
        <th>Moment X (kg&middot;m)</th><th>Moment Y (kg&middot;m)</th><th>Moment (kg&middot;m)</th></tr></thead>
      <tbody><tr>
        <td>${fmt(p.area, 2)}</td><td>${fmt(p.force)}</td>
        <td>${fmt(p.direction_deg)}</td><td>${fmt(p.centroid_height, 2)}</td>
        <td>${fmt(p.fx)}</td><td>${fmt(p.fy)}</td>
        <td>${fmt(p.moment_x)}</td><td>${fmt(p.moment_y)}</td><td>${fmt(p.moment)}</td>
      </tr></tbody>
    </table>`;

  const levelResults = data.sections.map(sec => `
    <h3>3.${p && p.force !== 0 ? sec.section + 1 : sec.section} Level ${sec.section} &mdash; height ${fmt(sec.height, 2)} m</h3>
    <table>
      <thead><tr>
        <th>Side</th><th>Conductor</th><th>n</th>
        <th>Wind (kg/m)</th><th>w<sub>res</sub> (kg/m)</th><th>Sag (m)</th>
        <th>T/cond (kg)</th><th>Pull (kg)</th><th>Wind force (kg)</th><th>Vertical (kg)</th>
      </tr></thead>
      <tbody>
        ${sec.sides.map(sd => `<tr>
          <td>${sd.side_name} @ ${fmt(sd.direction_deg)}&deg;</td>
          <td>${sd.conductor}</td>
          <td>${sd.count}</td>
          <td>${fmt(sd.wind_per_m, 3)}</td>
          <td>${fmt(sd.resultant_unit_weight, 3)}</td>
          <td>${fmt(sd.sag, 2)}${sd.sag_auto ? " *" : ""}</td>
          <td>${fmt(sd.tension_per_conductor)}</td>
          <td>${fmt(sd.tension_total)}</td>
          <td>${fmt(sd.wind_force)}</td>
          <td>${fmt(sd.vertical_load)}</td>
        </tr>`).join("")}
        <tr class="total-row">
          <td colspan="6">Level totals</td>
          <td>F<sub>X</sub> = ${fmt(sec.fx)} kg &nbsp; F<sub>Y</sub> = ${fmt(sec.fy)} kg</td>
          <td>M<sub>X</sub> = ${fmt(sec.moment_x)} &nbsp; M<sub>Y</sub> = ${fmt(sec.moment_y)} kg&middot;m</td>
          <td>${fmt(sec.force)} kg @ ${fmt(sec.direction_deg)}&deg;</td>
          <td>${fmt(sec.vertical_load)} kg</td>
        </tr>
      </tbody>
    </table>
    ${sec.sides.some(sd => sd.sag_auto)
      ? '<p class="ps-method">* sag calculated to equalize tension with the opposite side.</p>' : ""}`).join("");

  el("#print-sheet").innerHTML = `
    <div class="ps-header">
      <h1>Pole Load Calculation Sheet</h1>
    </div>
    <table class="ps-info">
      <tbody>
        <tr>
          <td class="ps-info-main"><b>Project:</b> ${escapeHtml(pay.project_name) || "&mdash;"}</td>
          <td><b>Date:</b> ${now.toLocaleDateString()} ${now.toLocaleTimeString()}</td>
        </tr>
        <tr>
          <td class="ps-info-main"><b>Structure:</b> ${escapeHtml(pay.structure_name) || "&mdash;"}</td>
          <td><b>Units:</b> kg, m</td>
        </tr>
      </tbody>
    </table>

    <h2>1. Input data</h2>
    <h3>1.1 Wind</h3>
    <table>
      <thead><tr><th>Wind pressure on conductors (kg/m&sup2;)</th>
        <th>Wind pressure on pole (kg/m&sup2;)</th><th>Wind angle (&deg;)</th></tr></thead>
      <tbody><tr>
        <td>${fmt(pay.wind_pressure)}</td>
        <td>${fmt(pay.pole.wind_pressure)}</td>
        <td>${fmt(pay.wind_angle)}</td>
      </tr></tbody>
    </table>

    <h3>1.2 Pole</h3>
    <table>
      <thead><tr><th>Size</th><th>No. of poles</th><th>Height above ground (m)</th>
        <th>Width at top (m)</th><th>Width at ground (m)</th><th>C<sub>d</sub></th>
        <th>Strength (kg&middot;m)</th></tr></thead>
      <tbody><tr>
        <td>${pay.pole.size}</td><td>${pay.pole.count}</td>
        <td>${fmt(pay.pole.height, 2)}</td><td>${fmt(pay.pole.width_top, 2)}</td>
        <td>${fmt(pay.pole.width_ground, 2)}</td><td>${fmt(pay.pole.drag_coefficient, 2)}</td>
        <td>${fmt(pay.pole.strength)}</td>
      </tr></tbody>
    </table>

    <h3>1.3 Conductors</h3>
    <table>
      <thead><tr><th>Level</th><th>Height (m)</th><th>Side</th><th>Conductor</th>
        <th>&empty; (mm)</th><th>Weight (kg/m)</th><th>n</th>
        <th>Span (m)</th><th>Sag (m)</th><th>Line angle (&deg;)</th></tr></thead>
      <tbody>${inputsTable}</tbody>
    </table>

    <h2>2. Method</h2>
    <p class="ps-method">
      Wind load per metre normal to conductor: p = P &middot; d &middot; |sin(&psi; &minus; &beta;)| &nbsp;&nbsp;
      Resultant unit weight: w<sub>r</sub> = &radic;(w&sup2; + p&sup2;) &nbsp;&nbsp;
      Dead-end tension: T = w<sub>r</sub> &middot; span&sup2; / (8 &middot; sag)<br>
      Wind span = weight span = span/2 per dead-end.
      Wind on pole = n &middot; C<sub>d</sub> &middot; P &middot; height &middot; (width<sub>top</sub> + width<sub>ground</sub>)/2,
      applied at the centroid of the trapezoidal area.
      Moments are taken at the ground line; X = 0&deg; axis, Y = 90&deg; axis.
    </p>

    <h2>3. Results</h2>
    ${poleResultHtml}
    ${levelResults}

    <h2>4. Summary at ground line</h2>
    <table>
      <thead><tr><th>Direction</th><th>Force (kg)</th><th>Moment (kg&middot;m)</th></tr></thead>
      <tbody>
        <tr><td>X axis (0&deg; &ndash; 180&deg;)</td><td>${fmt(s.fx)}</td><td>${fmt(s.moment_x)}</td></tr>
        <tr><td>Y axis (90&deg; &ndash; 270&deg;)</td><td>${fmt(s.fy)}</td><td>${fmt(s.moment_y)}</td></tr>
        <tr class="total-row"><td>Resultant @ ${fmt(s.force_direction_deg)}&deg;</td>
          <td>${fmt(s.resultant_force)}</td><td>${fmt(s.groundline_moment)}</td></tr>
      </tbody>
    </table>
    <p class="ps-method">Total vertical load: ${fmt(s.total_vertical_load)} kg</p>
    ${!data.strength_check ? "" : `
    <h2>5. Pole strength check</h2>
    <table>
      <thead><tr><th>Strength per pole (kg&middot;m)</th><th>Total capacity (kg&middot;m)</th>
        <th>Calculated moment (kg&middot;m)</th><th>Utilization (%)</th><th>Result</th></tr></thead>
      <tbody><tr class="${data.strength_check.ok ? "" : "total-row"}">
        <td>${fmt(data.strength_check.strength_per_pole)}</td>
        <td>${fmt(data.strength_check.capacity)}</td>
        <td>${fmt(s.groundline_moment)}</td>
        <td>${fmt(data.strength_check.utilization_pct)}</td>
        <td>${data.strength_check.ok ? "OK" : "OVERLOADED"}</td>
      </tr></tbody>
    </table>`}

    <div class="ps-sign">
      <div>Calculated by: ________________</div>
      <div>Checked by: ________________</div>
      <div>Date: ________________</div>
    </div>`;

  window.print();
}

/* ------------------------------------------------------------------ */
/* Init                                                               */
/* ------------------------------------------------------------------ */

function buildPoleSelect() {
  const select = el("#pole-size");
  select.innerHTML = '<option value="">Custom (enter values below)</option>';
  for (const p of poles) {
    const opt = document.createElement("option");
    opt.value = p.id;
    opt.textContent = `${p.size}  (${p.height_over_ground_m} m above ground)`;
    select.appendChild(opt);
  }
  select.addEventListener("change", () => {
    const p = poles.find(x => x.id === parseInt(select.value, 10));
    if (!p) return;                       // "Custom" keeps current values
    el("#pole-height").value = p.height_over_ground_m;
    el("#pole-width-top").value = p.width_top_m;
    el("#pole-width-ground").value = p.width_ground_m;
    el("#pole-cd").value = p.drag_coefficient;
    el("#pole-strength").value = p.strength_kg_m;
  });

  // default to the 12 m pole if present, otherwise the first entry
  const def = poles.find(p => p.size.includes("12 m")) || poles[0];
  if (def) {
    select.value = def.id;
    select.dispatchEvent(new Event("change"));
  }
}

async function init() {
  const [condRes, poleRes] = await Promise.all([
    fetch("/api/conductors"),
    fetch("/api/poles"),
  ]);
  conductors = await condRes.json();
  poles = await poleRes.json();
  buildPoleSelect();

  el("#add-section").addEventListener("click", addSection);
  el("#calculate").addEventListener("click", calculate);
  el("#print-btn").addEventListener("click", printSheet);

  addSection();
  // enable side 1 & 3 of the first level as a sensible starting point
  const firstSides = els(".side");
  [0, 2].forEach(i => {
    el(".enabled", firstSides[i]).checked = true;
    firstSides[i].classList.add("on");
  });
}

init();
