"""
Pole Load Calculator
--------------------
Calculates horizontal forces and bending moments on a pole carrying several
levels (sections) of dead-end conductors attached on up to four sides.

Units: kg (force), m (length), kg/m2 (wind pressure), kg/m (unit weight).

Method per conductor side:
  1. Wind load per metre normal to conductor:
         p_wind = P * d * |sin(wind_angle - conductor_direction)|
  2. Resultant unit weight (vertical weight + horizontal wind):
         w_r = sqrt(w^2 + p_wind^2)
  3. Dead-end tension (parabolic approximation):
         T = w_r * span^2 / (8 * sag)          [per conductor]
  4. Forces transmitted to the pole:
         - Tension pull  : n * T   along the conductor direction
         - Wind force    : n * p_wind * span/2 perpendicular to conductor
         - Vertical load : n * w * span/2      (weight span = half span)
  5. Bending moment at ground line = horizontal force x attachment height.
All horizontal forces are summed as vectors (x = 0 deg, y = 90 deg,
angles measured counter-clockwise).
"""
import math
import os
import sqlite3

from flask import Flask, g, jsonify, render_template, request

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DATABASE = os.path.join(BASE_DIR, "conductors.db")

app = Flask(__name__)

# ---------------------------------------------------------------------------
# Database
# ---------------------------------------------------------------------------

SEED_CONDUCTORS = [
    # (name, diameter_mm, weight_kg_per_m)
    ("AAC 50 mm2",        9.00, 0.135),
    ("AAC 95 mm2",       12.50, 0.261),
    ("AAC 120 mm2",      14.00, 0.328),
    ("AAC 185 mm2",      17.50, 0.511),
    ("ACSR 50/8 mm2",     9.60, 0.194),
    ("ACSR 95/15 mm2",   13.60, 0.383),
    ("ACSR 120/20 mm2",  15.50, 0.492),
    ("ACSR 185/30 mm2",  18.90, 0.735),
    ("ACSR 240/40 mm2",  21.80, 0.982),
    ("SAC 50 mm2 22kV",  15.20, 0.360),
    ("SAC 185 mm2 22kV", 21.20, 0.867),
    ("PC 25 mm2 (neutral)",  6.30, 0.070),
    ("OHGW 35 mm2 steel",    7.50, 0.276),
]

SEED_POLES = [
    # (size, height_over_ground_m, width_top_m, width_ground_m,
    #  drag_coefficient, strength_kg_m)  strength = moment capacity at ground line
    ("Concrete pole 8 m",     6.50, 0.15, 0.25, 1.0,  1100.0),
    ("Concrete pole 9 m",     7.50, 0.15, 0.26, 1.0,  1400.0),
    ("Concrete pole 12 m",   10.00, 0.19, 0.32, 1.0,  3500.0),
    ("Concrete pole 12.20 m", 10.20, 0.19, 0.33, 1.0,  3800.0),
    ("Concrete pole 14 m",   11.80, 0.23, 0.38, 1.0,  5500.0),
    ("Concrete pole 14.30 m", 12.10, 0.23, 0.39, 1.0,  6000.0),
    ("Concrete pole 16 m",   13.60, 0.26, 0.43, 1.0,  8000.0),
    ("Concrete pole 20 m",   17.20, 0.30, 0.50, 1.0, 12000.0),
    ("Concrete pole 22 m",   19.00, 0.33, 0.55, 1.0, 15000.0),
]


def get_db():
    if "db" not in g:
        g.db = sqlite3.connect(DATABASE)
        g.db.row_factory = sqlite3.Row
    return g.db


@app.teardown_appcontext
def close_db(exc):
    db = g.pop("db", None)
    if db is not None:
        db.close()


def init_db():
    con = sqlite3.connect(DATABASE)
    con.execute(
        """CREATE TABLE IF NOT EXISTS conductors (
               id INTEGER PRIMARY KEY AUTOINCREMENT,
               name TEXT NOT NULL UNIQUE,
               diameter_mm REAL NOT NULL,
               weight_kg_per_m REAL NOT NULL
           )"""
    )
    if con.execute("SELECT COUNT(*) FROM conductors").fetchone()[0] == 0:
        con.executemany(
            "INSERT INTO conductors (name, diameter_mm, weight_kg_per_m) VALUES (?, ?, ?)",
            SEED_CONDUCTORS,
        )
    con.execute(
        """CREATE TABLE IF NOT EXISTS poles (
               id INTEGER PRIMARY KEY AUTOINCREMENT,
               size TEXT NOT NULL UNIQUE,
               height_over_ground_m REAL NOT NULL,
               width_top_m REAL NOT NULL,
               width_ground_m REAL NOT NULL,
               drag_coefficient REAL NOT NULL DEFAULT 1.0,
               strength_kg_m REAL NOT NULL DEFAULT 0
           )"""
    )
    # migrate databases created before the strength column existed
    pole_cols = [r[1] for r in con.execute("PRAGMA table_info(poles)")]
    if "strength_kg_m" not in pole_cols:
        con.execute("ALTER TABLE poles ADD COLUMN strength_kg_m REAL NOT NULL DEFAULT 0")
        con.executemany(
            "UPDATE poles SET strength_kg_m = ? WHERE size = ?",
            [(row[5], row[0]) for row in SEED_POLES],
        )
    if con.execute("SELECT COUNT(*) FROM poles").fetchone()[0] == 0:
        con.executemany(
            """INSERT INTO poles
               (size, height_over_ground_m, width_top_m, width_ground_m,
                drag_coefficient, strength_kg_m)
               VALUES (?, ?, ?, ?, ?, ?)""",
            SEED_POLES,
        )
    con.commit()
    con.close()


# ---------------------------------------------------------------------------
# Calculation engine
# ---------------------------------------------------------------------------

SIDE_BASE_ANGLES = {0: 0.0, 1: 90.0, 2: 180.0, 3: 270.0}
SIDE_NAMES = {0: "Side 1 (0°)", 1: "Side 2 (90°)", 2: "Side 3 (180°)", 3: "Side 4 (270°)"}


def calc_side(side, wind_pressure, wind_angle_deg, conductor, target_tension=None):
    """Return force components and details for one conductor side.

    If target_tension is given, the sag is calculated so the tension per
    conductor equals it (balancing the opposite side); otherwise the sag
    from the input is used to calculate the tension.
    """
    n = int(side["count"])
    span = float(side["span"])
    line_angle = float(side.get("line_angle", 0.0))
    base = SIDE_BASE_ANGLES[int(side["side_index"])]
    direction = base + line_angle          # conductor leaves the pole this way

    d_m = conductor["diameter_mm"] / 1000.0
    w = conductor["weight_kg_per_m"]

    beta = math.radians(direction)
    omega = math.radians(wind_angle_deg - direction)   # wind relative to conductor

    # 1) wind load per metre normal to the conductor axis
    p_wind = wind_pressure * d_m * abs(math.sin(omega))

    # 2) resultant unit weight (kg/m)
    w_res = math.sqrt(w * w + p_wind * p_wind)

    # 3) dead-end tension per conductor (parabolic: T = w L^2 / 8D),
    #    or sag from a target tension (D = w L^2 / 8T)
    if target_tension is not None:
        tension = float(target_tension)
        sag = w_res * span * span / (8.0 * tension)
    else:
        sag = float(side["sag"])
        tension = w_res * span * span / (8.0 * sag)

    # 4) forces on the pole
    #    tension pull along conductor direction
    ft_x = n * tension * math.cos(beta)
    ft_y = n * tension * math.sin(beta)

    #    wind on conductor, wind span = span/2 for a dead-end
    f_wind_signed = n * p_wind * (span / 2.0) * (1 if math.sin(omega) >= 0 else -1)
    fw_x = f_wind_signed * (-math.sin(beta))
    fw_y = f_wind_signed * math.cos(beta)

    #    vertical load, weight span = span/2
    vertical = n * w * (span / 2.0)

    fx = ft_x + fw_x
    fy = ft_y + fw_y

    return {
        "side_index": int(side["side_index"]),
        "side_name": SIDE_NAMES[int(side["side_index"])],
        "conductor": conductor["name"],
        "count": n,
        "span": span,
        "sag": round(sag, 3),
        "sag_auto": target_tension is not None,
        "direction_deg": direction,
        "wind_per_m": round(p_wind, 4),
        "unit_weight": round(w, 4),
        "resultant_unit_weight": round(w_res, 4),
        "tension_per_conductor": round(tension, 2),
        "tension_total": round(n * tension, 2),
        "wind_force": round(abs(f_wind_signed), 2),
        "vertical_load": round(vertical, 2),
        "fx": fx,
        "fy": fy,
    }


def calc_pole_wind(pole, default_wind_pressure, wind_angle_deg):
    """Wind load on the pole shaft(s): trapezoidal projected area."""
    n = int(pole.get("count", 1))
    height = float(pole["height"])
    w_top = float(pole["width_top"])
    w_ground = float(pole["width_ground"])
    cd = float(pole.get("drag_coefficient", 1.0))
    # pole may use its own wind pressure; falls back to the conductor value
    wind_pressure = float(pole.get("wind_pressure", default_wind_pressure))

    area = height * (w_top + w_ground) / 2.0          # per pole, m2
    force = n * cd * wind_pressure * area             # kg, along wind direction

    # centroid height of the trapezoid measured from the ground line
    if w_top + w_ground > 0:
        centroid = height / 3.0 * (w_ground + 2.0 * w_top) / (w_ground + w_top)
    else:
        centroid = 0.0

    psi = math.radians(wind_angle_deg)
    fx = force * math.cos(psi)
    fy = force * math.sin(psi)

    return {
        "size": pole.get("size", "Custom"),
        "count": n,
        "wind_pressure": wind_pressure,
        "height": height,
        "width_top": w_top,
        "width_ground": w_ground,
        "drag_coefficient": cd,
        "area": round(n * area, 3),
        "force": round(force, 2),
        "direction_deg": wind_angle_deg,
        "centroid_height": round(centroid, 3),
        "moment": round(force * centroid, 2),
        "fx": fx,
        "fy": fy,
        "moment_x": round(fx * centroid, 2),
        "moment_y": round(fy * centroid, 2),
    }


def calculate(payload):
    db = get_db()
    wind_pressure = float(payload["wind_pressure"])
    wind_angle = float(payload["wind_angle"])

    total_fx = total_fy = 0.0
    total_mx = total_my = 0.0
    total_vertical = 0.0
    sections_out = []

    pole_out = None
    if payload.get("pole"):
        pole_out = calc_pole_wind(payload["pole"], wind_pressure, wind_angle)
        total_fx += pole_out["fx"]
        total_fy += pole_out["fy"]
        total_mx += pole_out["fx"] * pole_out["centroid_height"]
        total_my += pole_out["fy"] * pole_out["centroid_height"]
        pole_out["fx"] = round(pole_out["fx"], 2)
        pole_out["fy"] = round(pole_out["fy"], 2)

    for idx, section in enumerate(payload["sections"], start=1):
        height = float(section["height"])
        sec_fx = sec_fy = sec_vert = 0.0
        sides_out = []

        enabled = [s for s in section["sides"] if s.get("enabled")]
        # sides 1 & 2 first so sides 3 & 4 can balance against their tension
        by_index = {}
        for side in sorted(enabled, key=lambda s: int(s["side_index"])):
            row = db.execute(
                "SELECT * FROM conductors WHERE id = ?", (side["conductor_id"],)
            ).fetchone()
            if row is None:
                raise ValueError(f"Unknown conductor id {side['conductor_id']}")

            side_idx = int(side["side_index"])
            target = None
            if side_idx >= 2 and side.get("balance"):
                opposite = by_index.get(side_idx - 2)
                if opposite is None:
                    raise ValueError(
                        f"Level {idx}, Side {side_idx + 1}: cannot equalize tension "
                        f"because Side {side_idx - 1} is not enabled"
                    )
                target = opposite["tension_per_conductor"]

            result = calc_side(side, wind_pressure, wind_angle, dict(row), target)
            by_index[side_idx] = result
            sec_fx += result["fx"]
            sec_fy += result["fy"]
            sec_vert += result["vertical_load"]
            sides_out.append(result)

        sec_force = math.hypot(sec_fx, sec_fy)
        sec_dir = math.degrees(math.atan2(sec_fy, sec_fx)) if sec_force > 1e-9 else 0.0
        sec_moment = sec_force * height

        total_fx += sec_fx
        total_fy += sec_fy
        total_mx += sec_fx * height
        total_my += sec_fy * height
        total_vertical += sec_vert

        sections_out.append({
            "section": idx,
            "height": height,
            "sides": sides_out,
            "fx": round(sec_fx, 2),
            "fy": round(sec_fy, 2),
            "force": round(sec_force, 2),
            "direction_deg": round(sec_dir, 2),
            "moment_x": round(sec_fx * height, 2),
            "moment_y": round(sec_fy * height, 2),
            "moment": round(sec_moment, 2),
            "vertical_load": round(sec_vert, 2),
        })

    total_force = math.hypot(total_fx, total_fy)
    total_dir = math.degrees(math.atan2(total_fy, total_fx)) if total_force > 1e-9 else 0.0
    total_moment = math.hypot(total_mx, total_my)
    moment_dir = math.degrees(math.atan2(total_my, total_mx)) if total_moment > 1e-9 else 0.0

    # strength check: moment capacity of the pole(s) vs calculated moment
    strength_check = None
    if payload.get("pole") and float(payload["pole"].get("strength", 0)) > 0:
        capacity = float(payload["pole"]["strength"]) * int(payload["pole"].get("count", 1))
        utilization = total_moment / capacity * 100.0
        strength_check = {
            "strength_per_pole": round(float(payload["pole"]["strength"]), 1),
            "capacity": round(capacity, 1),
            "utilization_pct": round(utilization, 1),
            "ok": total_moment <= capacity,
        }

    return {
        "pole": pole_out,
        "strength_check": strength_check,
        "sections": sections_out,
        "summary": {
            "fx": round(total_fx, 2),
            "fy": round(total_fy, 2),
            "moment_x": round(total_mx, 2),
            "moment_y": round(total_my, 2),
            "resultant_force": round(total_force, 2),
            "force_direction_deg": round(total_dir, 2),
            "groundline_moment": round(total_moment, 2),
            "moment_direction_deg": round(moment_dir, 2),
            "total_vertical_load": round(total_vertical, 2),
        },
    }


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

@app.route("/")
def index():
    return render_template("index.html")


@app.route("/api/conductors")
def conductors():
    rows = get_db().execute(
        "SELECT id, name, diameter_mm, weight_kg_per_m FROM conductors ORDER BY name"
    ).fetchall()
    return jsonify([dict(r) for r in rows])


@app.route("/api/poles")
def poles():
    rows = get_db().execute(
        """SELECT id, size, height_over_ground_m, width_top_m, width_ground_m,
                  drag_coefficient, strength_kg_m
           FROM poles ORDER BY height_over_ground_m"""
    ).fetchall()
    return jsonify([dict(r) for r in rows])


@app.route("/api/calculate", methods=["POST"])
def api_calculate():
    try:
        return jsonify(calculate(request.get_json(force=True)))
    except (KeyError, TypeError, ValueError, ZeroDivisionError) as exc:
        return jsonify({"error": f"Invalid input: {exc}"}), 400


if __name__ == "__main__":
    init_db()
    app.run(debug=True, port=5000)
