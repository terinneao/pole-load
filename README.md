# Pole Load Calculator

Web app for calculating horizontal forces and bending moments on a pole
carrying several levels of dead-end conductors attached on up to four
sides of the pole. All units are **kg** and **m**.

## Features

- Multiple conductor levels (sections) — add or remove freely.
- Up to four dead-end sides per level (0°, 90°, 180°, 270° in plan view),
  each with its own conductor type, number of conductors, span, sag and
  line angle.
- Conductor data (diameter, unit weight) stored in a SQLite database
  (`conductors.db`), pre-seeded with common AAC / ACSR / SAC sizes.
- Pole data (size, height over ground, width at top, width at ground line,
  drag coefficient) stored in the same database (`poles` table), pre-seeded
  with standard concrete pole sizes (8–22 m). Selecting a pole size fills
  the pole fields, which stay editable ("Custom").
- Wind pressure (kg/m²) and wind angle applied globally.
- Wind load on the pole shaft itself: number of poles, height above ground,
  width at top / at ground line and drag coefficient. The force is
  `n · Cd · P · height · (width_top + width_ground)/2`, applied at the
  centroid height of the trapezoidal projected area and included in the
  force and moment totals.

## Calculation method

For each enabled conductor side:

1. **Wind load per metre** normal to the conductor axis
   `p = P · d · |sin(wind angle − conductor direction)|`
2. **Resultant unit weight** (vertical weight + horizontal wind)
   `w_r = √(w² + p²)`
3. **Dead-end tension** per conductor (parabolic approximation)
   `T = w_r · span² / (8 · sag)`
4. **Forces on the pole**
   - tension pull `n·T` along the conductor direction,
   - wind force `n·p·span/2` perpendicular to the conductor (wind span = half span),
   - vertical load `n·w·span/2` (weight span = half span).
5. All horizontal forces are summed as vectors per level and for the whole
   pole. Bending moment at the ground line is `Σ (horizontal force × attachment height)`,
   summed vectorially.

## Run

```powershell
pip install -r requirements.txt
python app.py
```

Then open http://127.0.0.1:5000

The conductor database is created and seeded automatically on first run.
To add conductors, edit the `conductors` table in `conductors.db`
(columns: `name`, `diameter_mm`, `weight_kg_per_m`) or extend
`SEED_CONDUCTORS` in `app.py` before deleting the database file.
