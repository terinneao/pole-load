"""Quick smoke test for the calculation API."""
import json
import math
import urllib.request

BASE = "http://127.0.0.1:5000"

conductors = json.load(urllib.request.urlopen(f"{BASE}/api/conductors"))
print(f"{len(conductors)} conductors loaded, first: {conductors[0]}")
acsr185 = next(c for c in conductors if "185/30" in c["name"])

payload = {
    "wind_pressure": 50.0,   # kg/m2
    "wind_angle": 90.0,      # blowing perpendicular to side-1 axis
    "sections": [
        {   # top level: 3-phase dead-end both directions (through line)
            "height": 9.0,
            "sides": [
                {"side_index": 0, "enabled": True, "conductor_id": acsr185["id"],
                 "count": 3, "span": 80, "sag": 1.0, "line_angle": 0},
                {"side_index": 2, "enabled": True, "conductor_id": acsr185["id"],
                 "count": 3, "span": 60, "sag": 0.8, "line_angle": 0},
            ],
        },
        {   # lower level: single side dead-end (terminal)
            "height": 7.0,
            "sides": [
                {"side_index": 1, "enabled": True, "conductor_id": acsr185["id"],
                 "count": 3, "span": 80, "sag": 1.0, "line_angle": 0},
            ],
        },
    ],
}

req = urllib.request.Request(
    f"{BASE}/api/calculate",
    data=json.dumps(payload).encode(),
    headers={"Content-Type": "application/json"},
)
result = json.load(urllib.request.urlopen(req))
print(json.dumps(result, indent=2))

# ---- hand check: side 1 of level 1 ----
d = acsr185["diameter_mm"] / 1000
w = acsr185["weight_kg_per_m"]
p = 50 * d * abs(math.sin(math.radians(90 - 0)))     # wind normal to conductor
w_r = math.sqrt(w**2 + p**2)
T = w_r * 80**2 / (8 * 1.0)
side = result["sections"][0]["sides"][0]
assert abs(side["tension_per_conductor"] - T) < 0.01, (side["tension_per_conductor"], T)
assert abs(side["resultant_unit_weight"] - w_r) < 1e-3
assert abs(side["vertical_load"] - 3 * w * 40) < 0.01
print(f"\nHand check OK: w_r={w_r:.4f} kg/m, T={T:.2f} kg per conductor")
