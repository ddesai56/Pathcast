// riskEngine.js
// Pathcast rev1 risk engine: weather + elevation + road class
// Two grids: 45-min waypoints drive the weather TIMELINE UI (unchanged)
//            adaptive geographic segments drive the RISK SCORE

// ─── ADAPTIVE SEGMENTATION ───────────────────────────────────────────────────
// Returns segment interval in miles based on total route length.
// Short routes stay fine-grained; long routes scale up to preserve API budget
// while avoiding the accuracy dilution of a hard cap.
export function getSegmentIntervalMiles(routeLengthMiles) {
  if (routeLengthMiles <= 150) return 5;
  if (routeLengthMiles <= 400) return 8;
  return 10;
}

// ─── GEOMETRY HELPER ─────────────────────────────────────────────────────────
// Haversine distance between two [lng, lat] points, returns meters
function haversineMeters([lng1, lat1], [lng2, lat2]) {
  const R = 6371000;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Walk the GeoJSON coordinate array and return evenly-spaced sample points.
// Each returned point: { coord: [lng, lat], distanceFromStartMeters }
export function sampleRouteByDistance(coordinates, intervalMeters) {
  const samples = [];
  let accumulated = 0;
  let nextTarget = 0; // first sample at distance 0 (route start)

  samples.push({ coord: coordinates[0], distanceFromStartMeters: 0 });
  nextTarget = intervalMeters;

  for (let i = 1; i < coordinates.length; i++) {
    const segLen = haversineMeters(coordinates[i - 1], coordinates[i]);
    const prevAccumulated = accumulated;
    accumulated += segLen;

    // Emit one or more samples that fall within this coordinate pair
    while (nextTarget <= accumulated) {
      const frac = (nextTarget - prevAccumulated) / segLen;
      const lng =
        coordinates[i - 1][0] + frac * (coordinates[i][0] - coordinates[i - 1][0]);
      const lat =
        coordinates[i - 1][1] + frac * (coordinates[i][1] - coordinates[i - 1][1]);
      samples.push({ coord: [lng, lat], distanceFromStartMeters: nextTarget });
      nextTarget += intervalMeters;
    }
  }

  // Always include the final point
  const last = coordinates[coordinates.length - 1];
  if (
    samples[samples.length - 1].distanceFromStartMeters < accumulated - 1
  ) {
    samples.push({ coord: last, distanceFromStartMeters: accumulated });
  }

  return samples;
}

// ─── BREAKPOINT INTERPOLATOR ─────────────────────────────────────────────────
function interpolate(value, breakpoints) {
  if (value <= breakpoints[0][0]) return breakpoints[0][1];
  if (value >= breakpoints[breakpoints.length - 1][0])
    return breakpoints[breakpoints.length - 1][1];
  for (let i = 0; i < breakpoints.length - 1; i++) {
    const [x0, y0] = breakpoints[i];
    const [x1, y1] = breakpoints[i + 1];
    if (value >= x0 && value <= x1) {
      return y0 + ((value - x0) / (x1 - x0)) * (y1 - y0);
    }
  }
  return 0;
}

// ─── FACTOR SCORERS ──────────────────────────────────────────────────────────

function scorePrecip(precipMm) {
  return interpolate(precipMm, [
    [0, 0], [0.5, 20], [1, 35], [2, 55], [3, 70], [5, 85], [8, 100],
  ]);
}

// Grade expressed as absolute elevation change / horizontal distance (both meters)
function scoreGrade(elevDiffMeters, segmentLengthMeters) {
  if (segmentLengthMeters <= 0) return 0;
  const gradePct = (Math.abs(elevDiffMeters) / segmentLengthMeters) * 100;
  return interpolate(gradePct, [
    [0, 0], [1, 5], [2, 15], [4, 35], [6, 55], [8, 72], [10, 85], [13, 100],
  ]);
}

// Open-Meteo returns visibility in meters — pass raw meters here
function scoreVisibility(visibilityMeters) {
  const km = visibilityMeters / 1000;
  return interpolate(km, [
    [0.4, 100], [1.6, 80], [3.2, 60], [8, 35], [16, 15], [32, 5], [75, 0],
  ]);
}

// Open-Meteo returns wind_speed_10m in km/h (we request wind_speed_unit=kmh)
function scoreWind(windKph) {
  return interpolate(windKph, [
    [0, 0], [16, 8], [32, 20], [48, 38], [72, 60], [96, 80], [120, 100],
  ]);
}

// Open-Meteo returns temperature_2m in Celsius
function scoreTemperature(tempC) {
  // Risk rises as temperature approaches and drops below freezing (0°C)
  // Above 4°C = 0 risk. Below -20°C = 100 risk.
  return interpolate(tempC, [
    [-20, 100], [-12, 90], [-6, 78], [-2, 60], [0, 40], [2, 8], [4, 0],
  ]);
}

// Road class from Mapbox step.maneuver or step.name context.
// We use step-level road_class extracted when steps=true is requested.
function scoreRoadClass(roadClass) {
  const map = {
    motorway: 5,
    trunk: 8,
    primary: 12,
    secondary: 18,
    tertiary: 25,
    residential: 35,
    service: 40,
    track: 60,
    ferry: 50,
  };
  return map[roadClass] ?? 15;
}

// ─── COMPOUND HAZARD MULTIPLIERS ─────────────────────────────────────────────
// Applied after base score. Only the highest applicable multiplier fires
// (they don't stack multiplicatively — that would over-penalize).

function applyMultipliers(baseScore, { precipMm, gradePct, tempC, visibilityMeters, roadClass, isDaytime }) {
  let multiplier = 1.0;
  const visKm = visibilityMeters / 1000;
  const isHighSpeed = ['motorway', 'trunk', 'primary'].includes(roadClass);

  // Rain + steep descent — most dangerous combo per FHWA data
  if (precipMm >= 1 && gradePct >= 4) multiplier = Math.max(multiplier, 1.45);

  // Ice + steep grade
  if (tempC <= 0 && gradePct >= 3) multiplier = Math.max(multiplier, 1.40);

  // Low visibility on a high-speed road
  if (visKm <= 1.6 && isHighSpeed) multiplier = Math.max(multiplier, 1.30);

  // Night + rain + low visibility (triple compound)
  if (!isDaytime && precipMm >= 0.5 && visKm <= 3.2) multiplier = Math.max(multiplier, 1.35);

  return Math.min(100, baseScore * multiplier);
}

// ─── SEGMENT SCORER ──────────────────────────────────────────────────────────
// weather: the Open-Meteo hourly object for the arrival hour at this segment
// elevDiffMeters: elevation at segment end minus elevation at segment start
// segmentLengthMeters: geographic length of this segment
// roadClass: string from Mapbox steps covering this segment
// arrivalHour: integer 0–23 — used to determine daytime

export function scoreSegment({ weather, elevDiffMeters, segmentLengthMeters, roadClass, arrivalHour }) {
  const precipMm       = weather?.precipitation     ?? 0;
  const windKph        = weather?.wind_speed_10m    ?? 0;
  const visibilityM    = weather?.visibility        ?? 24000; // default: clear
  const tempC          = weather?.temperature_2m    ?? 15;   // default: mild

  const gradePct = segmentLengthMeters > 0
    ? (Math.abs(elevDiffMeters) / segmentLengthMeters) * 100
    : 0;

  const isDaytime = arrivalHour >= 6 && arrivalHour < 20;

  // Individual factor scores (each 0–100)
  const fPrecip    = scorePrecip(precipMm);
  const fGrade     = scoreGrade(elevDiffMeters, segmentLengthMeters);
  const fVis       = scoreVisibility(visibilityM);
  const fWind      = scoreWind(windKph);
  const fTemp      = scoreTemperature(tempC);
  const fRoadClass = scoreRoadClass(roadClass);

  // Weighted sum — weights sum to 1.0
  const baseScore =
    fPrecip    * 0.33 +
    fGrade     * 0.22 +
    fVis       * 0.20 +
    fTemp      * 0.12 +
    fWind      * 0.08 +
    fRoadClass * 0.05;

  const finalScore = applyMultipliers(baseScore, {
    precipMm,
    gradePct,
    tempC,
    visibilityMeters: visibilityM,
    roadClass,
    isDaytime,
  });

  return {
    score: Math.round(finalScore),
    factors: {
      precipitation: Math.round(fPrecip),
      grade:         Math.round(fGrade),
      visibility:    Math.round(fVis),
      temperature:   Math.round(fTemp),
      wind:          Math.round(fWind),
      roadClass:     Math.round(fRoadClass),
    },
  };
}

// ─── ROUTE ROLLUP ────────────────────────────────────────────────────────────
// P90 of length-weighted segment scores + peak danger bonus.
// Avoids both the "single bad segment dominates" problem of max()
// and the "long safe highway dilutes a dangerous pass" problem of mean().

export function rollupRouteScore(segments) {
  if (!segments || segments.length === 0) return 0;

  const sorted = [...segments].sort((a, b) => a.score - b.score);
  const totalLength = sorted.reduce((sum, s) => sum + (s.lengthMeters ?? 1), 0);

  let cumulative = 0;
  let p90Score = sorted[sorted.length - 1].score;
  for (const seg of sorted) {
    cumulative += seg.lengthMeters ?? 1;
    if (cumulative / totalLength >= 0.9) {
      p90Score = seg.score;
      break;
    }
  }

  const peakScore = Math.max(...segments.map((s) => s.score));
  const peakBonus = peakScore > 70 ? (peakScore - 70) * 0.5 : 0;

  return Math.min(100, Math.round(p90Score * 0.75 + peakBonus));
}

// ─── FACTOR AGGREGATION ──────────────────────────────────────────────────────
// For the breakdown panel: show the worst value per factor across all segments.
// This reflects "what was the hardest moment" per dimension.

export function aggregateFactors(segments) {
  const keys = ['precipitation', 'grade', 'visibility', 'temperature', 'wind', 'roadClass'];
  const result = {};
  for (const key of keys) {
    result[key] = Math.max(...segments.map((s) => s.factors?.[key] ?? 0));
  }
  return result;
}

// ─── PLAIN ENGLISH EXPLANATION ───────────────────────────────────────────────

export function generateExplanation(routeScore, worstSegment, aggregatedFactors) {
  if (routeScore <= 15) return 'Conditions look clear. Safe to drive.';
  if (routeScore <= 30) return 'Minor weather along the route. Drive normally and stay alert.';

  const reasons = [];
  if (aggregatedFactors.precipitation >= 40) reasons.push('rain or snow');
  if (aggregatedFactors.grade >= 40)         reasons.push('steep grades');
  if (aggregatedFactors.visibility >= 40)    reasons.push('reduced visibility');
  if (aggregatedFactors.temperature >= 40)   reasons.push('near-freezing temperatures');
  if (aggregatedFactors.wind >= 40)          reasons.push('strong winds');

  const loc = worstSegment?.label ? ` near ${worstSegment.label}` : '';

  if (routeScore <= 60)
    return `Moderate risk${loc}. Watch for ${reasons.join(' and ')}. Reduce speed in affected areas.`;
  if (routeScore <= 80)
    return `Elevated risk${loc} — ${reasons.join(', ')}. Consider delaying or taking extra precautions.`;
  return `High risk${loc}. Dangerous conditions: ${reasons.join(', ')}. Strongly consider delaying this trip.`;
}