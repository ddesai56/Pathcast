// ── Weather code lookup ──────────────────────────────────────
const WEATHER_CODES = {
  0:  { label: 'Clear',        emoji: '☀️' },
  1:  { label: 'Partly cloudy', emoji: '⛅' },
  2:  { label: 'Partly cloudy', emoji: '⛅' },
  3:  { label: 'Partly cloudy', emoji: '⛅' },
  45: { label: 'Foggy',        emoji: '🌫️' },
  48: { label: 'Foggy',        emoji: '🌫️' },
  51: { label: 'Rain',          emoji: '🌧️' },
  53: { label: 'Rain',          emoji: '🌧️' },
  55: { label: 'Rain',          emoji: '🌧️' },
  61: { label: 'Rain',          emoji: '🌧️' },
  63: { label: 'Rain',          emoji: '🌧️' },
  65: { label: 'Rain',          emoji: '🌧️' },
  71: { label: 'Snow',          emoji: '❄️' },
  73: { label: 'Snow',          emoji: '❄️' },
  75: { label: 'Snow',          emoji: '❄️' },
  77: { label: 'Snow',          emoji: '❄️' },
  80: { label: 'Showers',       emoji: '🌦️' },
  81: { label: 'Showers',       emoji: '🌦️' },
  82: { label: 'Showers',       emoji: '🌦️' },
  95: { label: 'Thunderstorm',  emoji: '⛈️' },
  96: { label: 'Thunderstorm',  emoji: '⛈️' },
  99: { label: 'Thunderstorm',  emoji: '⛈️' },
}

export function getWeatherInfo(code, isNight = false) {
  const base = WEATHER_CODES[code] ?? WEATHER_CODES[0]
  if (!isNight) return base
  // Night overrides: clear sky → moon, partly cloudy → night cloud
  if (code === 0)                  return { ...base, emoji: '🌙' }
  if (code === 1 || code === 2 || code === 3) return { ...base, emoji: '🌥️' }
  return base
}

// ── Coordinate sampling ──────────────────────────────────────

/** Sample n evenly-spaced coordinates from a GeoJSON coordinate array */
export function sampleCoords(coords, n) {
  if (coords.length === 0) return []
  if (coords.length <= n) return [...coords]
  const result = []
  for (let i = 0; i < n; i++) {
    const idx = Math.min(
      Math.round((i / (n - 1)) * (coords.length - 1)),
      coords.length - 1
    )
    result.push(coords[idx])
  }
  return result
}

/** Sample coordinates at 45-minute intervals along the route */
export function sampleByTime(coords, durationSeconds) {
  const INTERVAL = 2700 // 45 min
  const points = [{ coords: coords[0], timeSeconds: 0 }]

  for (let t = INTERVAL; t < durationSeconds - 60; t += INTERVAL) {
    const fraction = t / durationSeconds
    const idx = Math.min(
      Math.round(fraction * (coords.length - 1)),
      coords.length - 1
    )
    points.push({ coords: coords[idx], timeSeconds: t })
  }

  // Always include the end point
  points.push({ coords: coords[coords.length - 1], timeSeconds: durationSeconds })
  return points
}

// ── Elevation fetching & processing ──────────────────────────

export async function fetchElevationData(sampledCoords) {
  const lats = sampledCoords.map(c => c[1]).join(',')
  const lngs = sampledCoords.map(c => c[0]).join(',')
  const res = await fetch(
    `https://api.open-meteo.com/v1/elevation?latitude=${lats}&longitude=${lngs}`
  )
  if (!res.ok) throw new Error('Elevation data unavailable')
  const data = await res.json()
  return data.elevation ?? []
}

export function processElevation(elevMeters, totalDistanceMiles) {
  if (elevMeters.length === 0) return null

  let gainM = 0
  for (let i = 1; i < elevMeters.length; i++) {
    const diff = elevMeters[i] - elevMeters[i - 1]
    if (diff > 0) gainM += diff
  }

  const maxM = Math.max(...elevMeters)
  const minM = Math.min(...elevMeters)
  const n = elevMeters.length
  const elevFeet = elevMeters.map(m => +(m * 3.281).toFixed(0))

  // Distance label for each sample point (miles)
  const distanceLabels = Array.from({ length: n }, (_, i) =>
    ((i / (n - 1)) * totalDistanceMiles).toFixed(1)
  )

  const fmtFt = (m) => `${Math.round(m * 3.281).toLocaleString()} ft`

  return {
    elevFeet,
    distanceLabels,
    gainFt: fmtFt(gainM),
    maxFt:  fmtFt(maxM),
    minFt:  fmtFt(minM),
  }
}

// ── Weather fetching & processing ────────────────────────────

/**
 * Format a Date as a UTC hour string matching Open-Meteo's hourly time format.
 * Example: "2025-06-15T14:00"
 */
function toUTCHourStr(date) {
  const y  = date.getUTCFullYear()
  const mo = String(date.getUTCMonth() + 1).padStart(2, '0')
  const d  = String(date.getUTCDate()).padStart(2, '0')
  const h  = String(date.getUTCHours()).padStart(2, '0')
  return `${y}-${mo}-${d}T${h}:00`
}

/**
 * Fetch forecasted conditions at a specific lat/lng for a specific arrival time.
 * Uses the hourly endpoint with UTC timezone so the target hour can be matched
 * consistently regardless of where the user or waypoints are located.
 */
async function fetchOneWeather(lat, lng, arrivalTime) {
  try {
    const targetHour = toUTCHourStr(arrivalTime)
    const res = await fetch(
      `https://api.open-meteo.com/v1/forecast` +
      `?latitude=${lat}&longitude=${lng}` +
      `&hourly=temperature_2m,precipitation,wind_speed_10m,visibility,weather_code` +
      `&wind_speed_unit=kmh&timezone=UTC&forecast_days=2`
    )
    if (!res.ok) return null
    const data = await res.json()

    // Find the hourly slot that matches the arrival hour
    const times = data.hourly?.time ?? []
    let idx = times.indexOf(targetHour)
    // If outside the 2-day window, clamp to last available slot
    if (idx === -1) idx = times.length - 1
    if (idx < 0)    return null

    return {
      temperature_2m: data.hourly.temperature_2m?.[idx] ?? 15,
      precipitation:  data.hourly.precipitation?.[idx]  ?? 0,
      wind_speed_10m: data.hourly.wind_speed_10m?.[idx] ?? 0,
      visibility:     data.hourly.visibility?.[idx]     ?? 24140,
      weather_code:   data.hourly.weather_code?.[idx]   ?? 0,
    }
  } catch {
    return null
  }
}

/**
 * Fetch forecasted weather for each time-stamped waypoint along the route.
 * @param {Array<{coords: [lng,lat], timeSeconds: number}>} timePoints
 * @param {Date} departureTime  — when the journey starts; offsets each waypoint's arrival
 */
export async function fetchWeatherData(timePoints, departureTime = new Date()) {
  const results = await Promise.all(
    timePoints.map(({ coords, timeSeconds }) => {
      const arrivalTime = new Date(departureTime.getTime() + timeSeconds * 1000)
      return fetchOneWeather(coords[1], coords[0], arrivalTime)
    })
  )

  return results.map((result, i) => {
    const code    = result?.weather_code   ?? 0
    const windKph = result?.wind_speed_10m ?? 0
    const visM    = result?.visibility     ?? 24140 // ~15 mi default
    const precip  = result?.precipitation  ?? 0
    const tempC   = result?.temperature_2m ?? 15

    // Night = before 6am or after 8pm local time at departure + offset
    const arrivalTime = new Date(departureTime.getTime() + timePoints[i].timeSeconds * 1000)
    const hour        = arrivalTime.getHours()
    const isNight     = hour < 6 || hour > 20

    return {
      coords:       timePoints[i].coords, // [lng, lat] — needed for map markers
      timeSeconds:  timePoints[i].timeSeconds,
      tempF:        Math.round(tempC * 9 / 5 + 32),
      precipMm:     precip,
      precipIn:     parseFloat((precip * 0.039).toFixed(2)),
      windMph:      Math.round(windKph * 0.621),
      visibilityMi: parseFloat((visM / 1609).toFixed(1)),
      weatherCode:  code,
      ...getWeatherInfo(code, isNight),
    }
  })
}

// ── Notable waypoints ─────────────────────────────────────────

/** Always returns exactly 4 slots: Start, End, Worst rain, Worst vis */
export function getNotableWaypoints(weatherPoints) {
  if (!weatherPoints?.length) return []
  const last       = weatherPoints.length - 1
  const worstRain  = [...weatherPoints].sort((a, b) => b.precipMm - a.precipMm)[0]
  const worstVis   = [...weatherPoints].sort((a, b) => a.visibilityMi - b.visibilityMi)[0]
  return [
    { role: 'Start',      ...weatherPoints[0]   },
    { role: 'End',        ...weatherPoints[last] },
    { role: 'Worst rain', ...worstRain            },
    { role: 'Worst vis.', ...worstVis             },
  ]
}

// ── Condition callout ─────────────────────────────────────────

const BAD_CODES = new Set([45, 48, 51, 53, 55, 61, 63, 65, 71, 73, 75, 77, 80, 81, 82, 95, 96, 99])

function fmtDur(seconds) {
  const h = Math.floor(seconds / 3600)
  const m = Math.round((seconds % 3600) / 60)
  return h === 0 ? `${m}m` : `${h}h ${m}m`
}

const ADVICE = {
  'Rain':         'reduce speed and increase following distance',
  'Showers':      'reduce speed and increase following distance',
  'Snow':         'use winter tyres and drive slowly',
  'Foggy':        'use fog lights and reduce speed',
  'Thunderstorm': 'consider delaying your journey if possible',
}

export function getConditionCallout(weatherPoints) {
  if (!weatherPoints?.length) return null

  const worst = [...weatherPoints]
    .filter(p => BAD_CODES.has(p.weatherCode) || p.precipMm > 0.1)
    .sort((a, b) =>
      (BAD_CODES.has(b.weatherCode) ? b.weatherCode : 0) -
      (BAD_CODES.has(a.weatherCode) ? a.weatherCode : 0) ||
      b.precipMm - a.precipMm
    )[0]

  if (!worst) return 'Conditions look good along this route.'

  const advice = ADVICE[worst.label] ?? 'drive with caution'
  const timeStr = fmtDur(worst.timeSeconds)
  return `Heads up: ${worst.label.toLowerCase()} expected around the ${timeStr} mark — ${advice}.`
}

// ── Main orchestrator ─────────────────────────────────────────

/**
 * @param {object} route         — Mapbox Directions route object
 * @param {Date}   departureTime — when the journey starts; defaults to now
 */
export async function fetchRouteConditions(route, departureTime = new Date()) {
  const coords             = route.geometry.coordinates
  const totalDistanceMiles = route.distance / 1609.344

  const elevSamples = sampleCoords(coords, 80)
  const timePoints  = sampleByTime(coords, route.duration)

  // Fetch elevation and all weather points in parallel
  const [elevMeters, weatherPoints] = await Promise.all([
    fetchElevationData(elevSamples),
    fetchWeatherData(timePoints, departureTime),
  ])

  const elevation = processElevation(elevMeters, totalDistanceMiles)
  const notable   = getNotableWaypoints(weatherPoints)
  const callout   = getConditionCallout(weatherPoints)

  const avgWindMph = Math.round(
    weatherPoints.reduce((s, p) => s + p.windMph, 0) / weatherPoints.length
  )
  const minVisMi  = Math.min(...weatherPoints.map(p => p.visibilityMi))
  const startTemp = weatherPoints[0]?.tempF ?? '--'
  const endTemp   = weatherPoints[weatherPoints.length - 1]?.tempF ?? '--'

  return {
    elevation,
    weatherPoints,
    notable,
    callout,
    stats: {
      wind:       `${avgWindMph} mph`,
      temp:       `${startTemp}°F → ${endTemp}°F`,
      visibility: `${minVisMi.toFixed(1)} mi`,
      gain:       elevation?.gainFt ?? '--',
    },
  }
}
