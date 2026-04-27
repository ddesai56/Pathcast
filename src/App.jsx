import { useState, useRef, useCallback, useEffect, useLayoutEffect } from 'react'
import mapboxgl from 'mapbox-gl'
import { Button } from '@/components/ui/button'
import { Navigation, MapPin, ChevronDown, ArrowUpDown, Clock, Layers } from 'lucide-react'
import MapView from '@/components/MapView'
import AutocompleteInput from '@/components/AutocompleteInput'
import ElevationChart from '@/components/ElevationChart'
import Toast from '@/components/Toast'
import { formatDuration, formatDistance } from '@/utils/format'
import {
  sampleCoords, sampleByTime,
  fetchWeatherData, fetchElevationData,
  processElevation, getNotableWaypoints, getConditionCallout,
  computeRouteRisk,
} from '@/utils/weatherElevation'

mapboxgl.accessToken = import.meta.env.VITE_MAPBOX_TOKEN
const TOKEN = import.meta.env.VITE_MAPBOX_TOKEN

// ── Design tokens ──────────────────────────────────────────────
const C = {
  pageBg:    '#0d0f14',
  sidebarBg: '#13161e',
  cardBg:    '#1a1e28',
  elevated:  '#222736',
  borderPri: 'rgba(255,255,255,0.07)',
  borderSec: 'rgba(255,255,255,0.12)',
  textPri:   '#f0f2f7',
  textSec:   '#8b90a0',
  textMuted: '#555b6e',
  accent:    '#00d4aa',
  riskLow:   '#00d4aa',
  riskMid:   '#f5a623',
  riskHigh:  '#ff4757',
}

const mono = "'DM Mono', monospace"

// Format a Date as the value required by <input type="datetime-local">
function toDatetimeLocal(date) {
  const pad = (n) => String(n).padStart(2, '0')
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}`
  )
}

// ── Bottom-sheet snap positions (mobile) ──────────────────────
// Sheet is height:90dvh fixed at bottom:0. translateY moves it down.
//   full  → translateY that keeps sheet top ≥ 100px below viewport top
//            Sheet top without translate = h - 0.9h = 0.1h.
//            To reach 100px clearance: translateY = max(0, 100 - 0.1h).
//   half  → translateY(40dvh px)    — 50 % visible
//   peek  → translateY(90dvh-120px) — only 120 px visible
function getSnapPx(pos) {
  const h = window.innerHeight
  if (pos === 'full') return Math.max(0, Math.round(100 - h * 0.1))
  if (pos === 'half') return Math.round(h * 0.4)
  return Math.round(h * 0.9 - 120)  // peek
}

// ── Map style catalogue ───────────────────────────────────────
// dark:true → teal inactive tint (Dark / Satellite group)
// Order: Dark · Satellite · divider · Streets · Outdoors
const MAP_STYLES = [
  { id: 'dark',      label: 'Dark',      url: 'mapbox://styles/mapbox/dark-v11',              dark: true,  tileColor: '#1a1e28' },
  { id: 'satellite', label: 'Satellite', url: 'mapbox://styles/mapbox/satellite-streets-v12', dark: true,  tileColor: '#2d4a2d' },
  { id: 'streets',   label: 'Streets',   url: 'mapbox://styles/mapbox/streets-v12',           dark: false, tileColor: '#2a2e3a' },
  { id: 'outdoors',  label: 'Outdoors',  url: 'mapbox://styles/mapbox/outdoors-v12',          dark: false, tileColor: '#1e3040' },
]

// ── Re-add only the GeoJSON route sources/layers after a style change. ─
// DOM markers survive setStyle automatically; only GL layers need re-adding.
// Layer order: border → line (ensures coloured line sits on top)
function routeBorderPaint(isActive) {
  return isActive
    ? { 'line-color': '#000000', 'line-width': 7,  'line-opacity': 0.38 }
    : { 'line-color': '#ffffff', 'line-width': 7,  'line-opacity': 0.50 }
}
function routeLinePaint(isActive) {
  return isActive
    ? { 'line-color': '#00d4aa', 'line-width': 5,  'line-opacity': 1 }
    : { 'line-color': '#9696aa', 'line-width': 4,  'line-opacity': 0.85, 'line-dasharray': [3, 2] }
}

function redrawRouteLines(map, routeData, activeIdx) {
  const order = routeData.length === 2
    ? (activeIdx === 0 ? [1, 0] : [0, 1])
    : [0]
  order.forEach(i => {
    if (!routeData[i]) return
    const isActive = i === activeIdx
    map.addSource(`route-${i}`, {
      type: 'geojson',
      data: { type: 'Feature', properties: {}, geometry: routeData[i].geometry },
    })
    map.addLayer({
      id: `route-border-${i}`, type: 'line', source: `route-${i}`,
      layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: routeBorderPaint(isActive),
    })
    map.addLayer({
      id: `route-layer-${i}`, type: 'line', source: `route-${i}`,
      layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: routeLinePaint(isActive),
    })
  })
}

const RISK_FACTORS = [
  { key: 'precipitation', label: 'Precipitation', weight: 33 },
  { key: 'grade',         label: 'Grade',         weight: 22 },
  { key: 'visibility',    label: 'Visibility',    weight: 20 },
  { key: 'temperature',   label: 'Temperature',   weight: 12 },
  { key: 'wind',          label: 'Wind',          weight:  8 },
  { key: 'roadClass',     label: 'Road class',    weight:  5 },
]

// ── Risk / condition colour helpers ───────────────────────────
function scoreColor(score) {
  if (score <= 30) return C.riskLow
  if (score <= 60) return C.riskMid
  return C.riskHigh
}

function waypointRiskColor(pt) {
  if (pt.windMph > 30 || pt.precipMm > 1)   return C.riskHigh
  if (pt.windMph > 20 || pt.precipMm > 0.1) return C.riskMid
  return C.accent
}

// ── Elevation gain in a ±windowMiles window around a route fraction ──
function localElevGain(elevFeet, distanceLabels, centerFraction, windowMiles = 30) {
  if (!elevFeet || !distanceLabels) return 0
  const totalMiles  = parseFloat(distanceLabels[distanceLabels.length - 1])
  const centerMile  = centerFraction * totalMiles
  const half        = windowMiles / 2
  let gain = 0
  for (let i = 1; i < elevFeet.length; i++) {
    const mile = parseFloat(distanceLabels[i])
    if (mile < centerMile - half || mile > centerMile + half) continue
    const diff = elevFeet[i] - elevFeet[i - 1]
    if (diff > 0) gain += diff
  }
  return gain
}

// ── Reverse geocode a coordinate to its nearest city name ────
async function fetchCityName(lng, lat) {
  try {
    const res = await fetch(
      `https://api.mapbox.com/geocoding/v5/mapbox.places/${lng},${lat}.json` +
      `?types=place&access_token=${TOKEN}`
    )
    if (!res.ok) return null
    const data = await res.json()
    return data.features?.[0]?.text ?? null
  } catch {
    return null
  }
}

// ── Generate Route Alerts from weather + elevation data ───────
function generateAlerts(weatherPoints, cityNames, elevation) {
  const alerts = []
  const seen   = new Set()
  const n      = weatherPoints.length

  weatherPoints.forEach((pt, i) => {
    const city     = cityNames[i] || 'this location'
    const time     = formatTimeline(pt.timeSeconds)
    const fraction = n > 1 ? i / (n - 1) : 0

    if (!seen.has('rain') && pt.precipMm > 0.1) {
      seen.add('rain')
      const gain    = localElevGain(elevation?.elevFeet, elevation?.distanceLabels, fraction)
      const context = gain > 200
        ? 'wet road on a descent — reduce speed'
        : 'allow extra following distance'
      alerts.push({
        type: 'rain', emoji: '🌧️',
        title:    `Rain at ${time}`,
        subtitle: `${pt.label} near ${city} — ${context}`,
        meta:     `${time} · ${city}`,
      })
    }

    if (!seen.has('wind') && pt.windMph > 20) {
      seen.add('wind')
      alerts.push({
        type: 'wind', emoji: '💨',
        title:    `Strong winds at ${time}`,
        subtitle: `${pt.windMph} mph near ${city} — allow extra space when overtaking`,
        meta:     `${time} · ${city}`,
      })
    }

    if (!seen.has('freeze') && pt.tempF < 35) {
      seen.add('freeze')
      alerts.push({
        type: 'freeze', emoji: '🧊',
        title:    `Freezing risk at ${time}`,
        subtitle: `Temperature drops to ${pt.tempF}°F near ${city} — watch for black ice on bridges and elevated sections`,
        meta:     `${time} · ${city}`,
      })
    }

    if (!seen.has('vis') && pt.visibilityMi < 3) {
      seen.add('vis')
      alerts.push({
        type: 'vis', emoji: '🌫️',
        title:    `Low visibility at ${time}`,
        subtitle: `${pt.visibilityMi} mi visibility near ${city} — use fog lights and reduce speed`,
        meta:     `${time} · ${city}`,
      })
    }
  })

  if (alerts.length === 0) {
    alerts.push({
      type: 'clear', emoji: '✅',
      title:    'All clear',
      subtitle: 'No significant weather concerns along this route.',
      meta:     null,
    })
  }
  return alerts
}

// ── Sample ≤ maxMarkers evenly-spaced points for map display ──
function sampleMarkersToShow(points, max = 8) {
  if (points.length <= max) return points
  return Array.from({ length: max }, (_, i) =>
    points[Math.round((i / (max - 1)) * (points.length - 1))]
  )
}

// ── Risk score interpolation ──────────────────────────────────
function interpolateScore(value, breakpoints) {
  if (value <= breakpoints[0][0])                       return breakpoints[0][1]
  if (value >= breakpoints[breakpoints.length - 1][0]) return breakpoints[breakpoints.length - 1][1]
  for (let i = 0; i < breakpoints.length - 1; i++) {
    const [v0, s0] = breakpoints[i]
    const [v1, s1] = breakpoints[i + 1]
    if (value >= v0 && value <= v1) return s0 + (s1 - s0) * (value - v0) / (v1 - v0)
  }
  return 0
}

function riskLabel(total) {
  if (total <= 30) return 'Low risk'
  if (total <= 60) return 'Moderate risk'
  if (total <= 80) return 'Elevated risk'
  return 'High risk'
}

// ── Navigation handoff — open route in external app ──────────
// Mapbox stores coords as [lng, lat]; mapping apps expect lat, lng.

function openGoogleMaps(originCoords, destCoords) {
  const [oLng, oLat] = originCoords
  const [dLng, dLat] = destCoords
  window.open(
    `https://www.google.com/maps/dir/?api=1` +
    `&origin=${oLat},${oLng}&destination=${dLat},${dLng}&travelmode=driving`,
    '_blank'
  )
}

function openAppleMaps(originCoords, destCoords) {
  const [oLng, oLat] = originCoords
  const [dLng, dLat] = destCoords
  const isMobile = /iPad|iPhone|iPod/.test(navigator.userAgent)
  const url = isMobile
    ? `maps://?saddr=${oLat},${oLng}&daddr=${dLat},${dLng}&dirflg=d`
    : `https://maps.apple.com/?saddr=${oLat},${oLng}&daddr=${dLat},${dLng}&dirflg=d`
  window.open(url, '_blank')
}

function openWaze(originCoords, destCoords) {
  const [oLng, oLat] = originCoords
  const [dLng, dLat] = destCoords
  const isMobile = /iPad|iPhone|iPod|Android/.test(navigator.userAgent)
  if (isMobile) {
    window.open(
      `waze://?ll=${dLat},${dLng}&navigate=yes&from=${oLat},${oLng}`,
      '_blank'
    )
    // Fallback to Waze web if the app isn't installed
    setTimeout(() => {
      window.location.href = `https://waze.com/ul?ll=${dLat},${dLng}&navigate=yes`
    }, 1500)
  } else {
    window.open(
      `https://www.waze.com/ul?ll=${dLat},${dLng}&navigate=yes&from=${oLat},${oLng}`,
      '_blank'
    )
  }
}

const NAV_APPS = [
  { id: 'google', label: 'Google Maps', labelColor: '#4285F4', tooltip: 'Opens in Google Maps', handler: openGoogleMaps },
  { id: 'apple',  label: 'Apple Maps',  labelColor: '#f0f2f7', tooltip: 'Opens in Apple Maps',  handler: openAppleMaps  },
  { id: 'waze',   label: 'Waze',        labelColor: '#33CCFF', tooltip: 'Opens in Waze',        handler: openWaze       },
]

// ── Shared UI primitives ──────────────────────────────────────
const SectionLabel = ({ children }) => (
  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
    <div style={{ width: 3, height: 14, background: C.accent, borderRadius: 1, flexShrink: 0 }} />
    <p style={{ fontSize: 12, fontWeight: 600, letterSpacing: '0.1em', textTransform: 'uppercase', color: C.textPri }}>
      {children}
    </p>
  </div>
)
const Divider = () => (
  <div style={{ height: 1, background: 'rgba(255,255,255,0.1)', flexShrink: 0 }} />
)

// ── Collapsible section header (teal bar + title + chevron) ──
function AccordionLabel({ children, open, onToggle }) {
  return (
    <div
      onClick={onToggle}
      style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        cursor: 'pointer', userSelect: 'none',
        marginBottom: open ? 10 : 0, transition: 'margin-bottom 0.25s ease',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <div style={{ width: 3, height: 14, background: C.accent, borderRadius: 1, flexShrink: 0 }} />
        <p style={{ fontSize: 12, fontWeight: 600, letterSpacing: '0.1em', textTransform: 'uppercase', color: C.textPri }}>
          {children}
        </p>
      </div>
      <span style={{
        fontSize: 10, color: C.textMuted, display: 'inline-block',
        transform: open ? 'rotate(0deg)' : 'rotate(-90deg)',
        transition: 'transform 0.2s ease',
      }}>▾</span>
    </div>
  )
}

// ── Map style toggle — frosted dark pill ───────────────────────
// Dark · Satellite | Streets · Outdoors
// A thin divider separates the two groups visually.
function MapStyleToggle({ activeStyleId, onStyleChange, style: wrapStyle }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 2,
      background: 'rgba(13,15,20,0.85)',
      backdropFilter: 'blur(8px)',
      WebkitBackdropFilter: 'blur(8px)',
      borderRadius: 10,
      padding: 4,
      boxShadow: '0 2px 12px rgba(0,0,0,0.5)',
      ...wrapStyle,
    }}>
      {MAP_STYLES.map((s, i) => {
        const active = s.id === activeStyleId
        // Divider between Satellite (index 1) and Streets (index 2)
        const showDivider = i === 2
        return (
          <>
            {showDivider && (
              <div key="divider" style={{
                width: 1, height: 16, flexShrink: 0,
                background: 'rgba(255,255,255,0.15)',
                margin: '0 2px',
              }} />
            )}
            <button
              key={s.id}
              onClick={() => onStyleChange(s)}
              style={{
                background:  active ? '#00d4aa'                         : 'transparent',
                color:       active ? '#000'
                           : s.dark ? 'rgba(0,212,170,0.7)'
                           :          'rgba(255,255,255,0.5)',
                border: 'none',
                borderRadius: 7,
                padding: '5px 10px',
                fontSize: 12,
                fontFamily: "'DM Sans', sans-serif",
                fontWeight: active ? 600 : 400,
                cursor: 'pointer',
                transition: 'background 0.15s ease, color 0.15s ease',
                whiteSpace: 'nowrap',
                lineHeight: 1,
              }}
            >
              {s.label}
            </button>
          </>
        )
      })}
    </div>
  )
}

// ── Mobile layers button + style picker ──────────────────────
function MobileLayersBtn({ activeStyleId, isOpen, onClick }) {
  const isCustom = activeStyleId !== 'dark'
  return (
    <button
      onClick={onClick}
      title="Map style"
      style={{
        width: 40, height: 40, borderRadius: '50%',
        background: 'rgba(19,22,30,0.9)',
        border: `1px solid rgba(255,255,255,0.12)`,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        cursor: 'pointer',
        color: isCustom || isOpen ? '#00d4aa' : '#8b90a0',
        boxShadow: '0 2px 12px rgba(0,0,0,0.5)',
        transition: 'color 0.15s',
      }}
    >
      <Layers size={20} />
    </button>
  )
}

const STYLE_TILE_ICONS = {
  dark: (
    <svg viewBox="0 0 24 24" fill="currentColor" width="32" height="32">
      <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>
    </svg>
  ),
  satellite: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="32" height="32">
      <circle cx="12" cy="12" r="3"/>
      <path d="M6.3 6.3a8 8 0 0 0 0 11.4M17.7 6.3a8 8 0 0 1 0 11.4"/>
      <path d="M3.5 3.5a13 13 0 0 0 0 17M20.5 3.5a13 13 0 0 1 0 17"/>
    </svg>
  ),
  streets: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="32" height="32">
      <line x1="12" y1="2" x2="12" y2="22"/>
      <line x1="2" y1="12" x2="22" y2="12"/>
      <rect x="6" y="6" width="12" height="12" rx="1"/>
    </svg>
  ),
  outdoors: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="32" height="32">
      <polygon points="3 20 9 4 15 14 18 10 21 20"/>
    </svg>
  ),
}

function MobileStylePicker({ activeStyleId, onSelect, onClose }) {
  return (
    <>
      {/* Full-screen tap-away backdrop */}
      <div
        onClick={onClose}
        style={{ position: 'fixed', inset: 0, zIndex: 125 }}
      />
      {/* Picker card — anchored top-right below the button */}
      <div style={{
        position: 'fixed', top: 160, right: 12, zIndex: 126,
        background: '#1a1e28',
        border: '1px solid rgba(255,255,255,0.12)',
        borderRadius: 16, padding: 16,
        boxShadow: '0 8px 32px rgba(0,0,0,0.4)',
        display: 'grid', gridTemplateColumns: 'repeat(2, 72px)', gap: 10,
      }}>
        {MAP_STYLES.map(s => {
          const active = s.id === activeStyleId
          return (
            <button
              key={s.id}
              onClick={() => { onSelect(s); onClose() }}
              style={{
                display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6,
                background: 'none', border: 'none', padding: 0, cursor: 'pointer',
              }}
            >
              <div style={{
                width: 72, height: 72, borderRadius: 10,
                background: '#222736',
                border: active ? '2px solid #00d4aa' : '1px solid rgba(255,255,255,0.08)',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                color: active ? '#00d4aa' : '#8b90a0',
                transition: 'border-color 0.15s, color 0.15s',
              }}>
                {STYLE_TILE_ICONS[s.id]}
              </div>
              <span style={{
                fontSize: 11, color: active ? '#00d4aa' : '#8b90a0',
                fontFamily: "'DM Sans', sans-serif",
                transition: 'color 0.15s',
              }}>
                {s.label}
              </span>
            </button>
          )
        })}
      </div>
    </>
  )
}

// ── Navigation handoff button ─────────────────────────────────
// Dark card: single centered brand-colored label.
function NavBtn({ label, labelColor, tooltip, disabled, onClick }) {
  const [hovered, setHovered] = useState(false)
  return (
    <button
      title={tooltip}
      onClick={disabled ? undefined : onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: hovered && !disabled ? C.elevated : C.cardBg,
        border: `1px solid ${C.borderSec}`,
        borderRadius: 8,
        padding: '10px 8px',
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.4 : 1,
        transition: 'background 0.15s ease, opacity 0.2s ease',
      }}
    >
      <span style={{
        fontSize: 13, fontWeight: 500, lineHeight: 1,
        color: disabled ? C.textMuted : labelColor,
        fontFamily: "'DM Sans', sans-serif",
      }}>{label}</span>
    </button>
  )
}

// ── Time label for timeline (e.g. "0 min", "45 min", "1h 30m") ──
function formatTimeline(seconds) {
  if (seconds === 0) return '0 min'
  const h = Math.floor(seconds / 3600)
  const m = Math.round((seconds % 3600) / 60)
  if (h === 0) return `${m} min`
  if (m === 0) return `${h}h`
  return `${h}h ${m}m`
}

// ── Clock time from departure + offset (e.g. "2:45 PM") ──
function formatClockTime(departureStr, offsetSeconds) {
  const base = new Date(departureStr)
  if (isNaN(base)) return ''
  const arrival = new Date(base.getTime() + offsetSeconds * 1000)
  return arrival.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}

// ── Map element creators ──────────────────────────────────────
function createRouteMarkerEl(label) {
  const el = document.createElement('div')
  Object.assign(el.style, {
    width: '28px', height: '28px', borderRadius: '50%',
    background: '#00d4aa', color: '#000',
    fontFamily: "'DM Sans', sans-serif",
    fontSize: '12px', fontWeight: '600',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    boxShadow: '0 2px 12px rgba(0,212,170,0.5)',
    border: '2px solid rgba(0,0,0,0.2)',
    userSelect: 'none', cursor: 'default',
  })
  el.textContent = label
  return el
}

function createElevHoverEl() {
  const wrap = document.createElement('div')
  wrap.style.cssText = 'position:relative;width:14px;height:14px;pointer-events:none;'
  const ring = document.createElement('div')
  ring.style.cssText = [
    'position:absolute;width:24px;height:24px;border-radius:50%;',
    'background:rgba(245,166,35,0.35);top:-5px;left:-5px;',
    'animation:pc-pulse-amber 1s ease-in-out infinite;',
  ].join('')
  const dot = document.createElement('div')
  dot.style.cssText = 'position:absolute;width:14px;height:14px;border-radius:50%;background:#f5a623;top:0;left:0;'
  wrap.appendChild(ring)
  wrap.appendChild(dot)
  return wrap
}

function createWeatherPillEl(emoji) {
  const el = document.createElement('div')
  el.style.cssText = [
    'background:white;border:1px solid rgba(0,0,0,0.15);',
    'padding:2px 6px;border-radius:99px;font-size:14px;',
    'cursor:default;user-select:none;line-height:1.3;',
    'white-space:nowrap;',
  ].join('')
  el.textContent = emoji
  return el
}

function weatherPopupHtml(pt) {
  return [
    '<div style="background:#13161e;border:1px solid rgba(255,255,255,0.12);',
    'border-radius:8px;padding:8px 10px;font-family:\'DM Sans\',sans-serif;',
    'font-size:12px;color:#f0f2f7;box-shadow:0 4px 20px rgba(0,0,0,0.6);min-width:130px;">',
    `<div style="font-weight:500;margin-bottom:4px">${pt.emoji} ${pt.label}</div>`,
    `<div style="color:#8b90a0;line-height:1.6">`,
    `${pt.tempF}°F<br>`,
    `${pt.windMph} mph wind<br>`,
    `${pt.precipIn > 0 ? pt.precipIn + ' in precip.' : 'No precipitation'}`,
    `</div></div>`,
  ].join('')
}

// ── Route drawing ──────────────────────────────────────────────
function drawRoutesOnMap(map, routeData, activeIdx, markers) {
  markers.forEach(m => m.remove())
  markers.length = 0
  // Remove line → border → source in that order (layers must go before their source)
  for (let i = 0; i < 2; i++) {
    if (map.getLayer(`route-layer-${i}`))  map.removeLayer(`route-layer-${i}`)
    if (map.getLayer(`route-border-${i}`)) map.removeLayer(`route-border-${i}`)
    if (map.getSource(`route-${i}`))       map.removeSource(`route-${i}`)
  }
  const order = routeData.length === 2
    ? (activeIdx === 0 ? [1, 0] : [0, 1])
    : [0]
  order.forEach(i => {
    if (!routeData[i]) return
    const isActive = i === activeIdx
    map.addSource(`route-${i}`, {
      type: 'geojson',
      data: { type: 'Feature', properties: {}, geometry: routeData[i].geometry },
    })
    // Border layer first (sits below the coloured line)
    map.addLayer({
      id: `route-border-${i}`, type: 'line', source: `route-${i}`,
      layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: routeBorderPaint(isActive),
    })
    map.addLayer({
      id: `route-layer-${i}`, type: 'line', source: `route-${i}`,
      layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: routeLinePaint(isActive),
    })
  })
}

// ── Add weather waypoint pill markers ─────────────────────────
function addWeatherMarkersToMap(map, weatherPoints, storeArr) {
  weatherPoints.forEach(pt => {
    const el = createWeatherPillEl(pt.emoji)
    const popup = new mapboxgl.Popup({
      closeButton: false,
      offset: 12,
      className: 'weather-popup',
      focusAfterOpen: false,
    }).setLngLat(pt.coords).setHTML(weatherPopupHtml(pt))

    el.addEventListener('mouseenter', () => popup.addTo(map))
    el.addEventListener('mouseleave', () => popup.remove())

    const marker = new mapboxgl.Marker({ element: el, anchor: 'bottom' })
      .setLngLat(pt.coords)
      .addTo(map)

    // Attach popup ref so we can clean it up later
    marker._popup = popup
    storeArr.push(marker)
  })
}

// ── Main component ────────────────────────────────────────────
export default function App() {
  // Input state
  const [originText,   setOriginText]   = useState('')
  const [destText,     setDestText]     = useState('')
  const [originCoords, setOriginCoords] = useState(null)
  const [destCoords,   setDestCoords]   = useState(null)

  // Departure time — only active when useScheduled is true
  const [useScheduled,  setUseScheduled]  = useState(false)
  const [departureTime, setDepartureTime] = useState(() => toDatetimeLocal(new Date()))

  // Route filter options — passed as Mapbox exclude params
  const [avoidTolls,    setAvoidTolls]    = useState(false)
  const [avoidHighways, setAvoidHighways] = useState(false)
  const [avoidFerries,  setAvoidFerries]  = useState(false)

  // Mobile inline departure picker (separate from desktop toggle)
  const [mobilePickerOpen,  setMobilePickerOpen]  = useState(false)
  const [pickerScheduled,   setPickerScheduled]   = useState(false)
  const [pickerTime,        setPickerTime]         = useState('')

  // Route state
  const [routes,         setRoutes]         = useState([])
  const [activeRouteIdx, setActiveRouteIdx] = useState(0)
  const [loading,        setLoading]        = useState(false)
  const [toast,          setToast]          = useState(null)

  // Conditions state — one entry per route index, filled in parallel after Find Route
  const [allConditions,     setAllConditions]     = useState([])   // conditions[routeIdx]
  const [allRiskScores,     setAllRiskScores]     = useState([])   // {total,scores}[routeIdx]
  const [allAlerts,         setAllAlerts]         = useState([])   // alerts[][routeIdx]
  const [conditionsLoading, setConditionsLoading] = useState(false)
  const [loadingPhase,      setLoadingPhase]      = useState(null) // 'weather'|'elevation'|null

  // ── Map style ──
  const [activeStyleId, setActiveStyleId] = useState('dark')

  // ── Accordion open/closed state (desktop + mobile) ──
  const [deptOpen,           setDeptOpen]           = useState(true)
  const [routeOptOpen,       setRouteOptOpen]       = useState(true)
  const [mobileRouteOptOpen, setMobileRouteOptOpen] = useState(true)
  // True when the user edits settings after a route was already searched
  const [needsResearch,      setNeedsResearch]      = useState(false)

  // ── Mobile UI state ──
  const [isMobile,          setIsMobile]          = useState(() => window.innerWidth < 768)
  const [topBarCollapsed,   setTopBarCollapsed]   = useState(false)
  const [sheetPos,          setSheetPos]          = useState('peek') // 'peek'|'half'|'full'
  const [stylePickerOpen,   setStylePickerOpen]   = useState(false)

  // Stable refs
  const mapRef              = useRef(null)
  const markersRef          = useRef([])    // route A/B endpoint markers
  const weatherMarkersRef   = useRef([])    // 45-min weather pill markers
  const elevHoverMarkerRef  = useRef(null)  // pulsing elevation hover marker
  const routesRef           = useRef([])
  const allConditionsRef    = useRef([])    // mirrors allConditions for use in callbacks
  const originCoordsRef     = useRef(null)
  const destCoordsRef       = useRef(null)
  const activeRouteIdxRef   = useRef(0)
  const routeListenersRef   = useRef([])   // {type,layerId,fn}[] — cleared before each re-attach
  const routeHoverPopupRef  = useRef(null) // Mapbox Popup for alt-route hover tooltip
  // Bottom-sheet drag state (mobile)
  const sheetRef = useRef(null)
  const dragRef  = useRef({ dragging: false, startY: 0, startTranslate: 0, lastY: 0, lastTime: 0, velocity: 0 })

  // ── Map ready ──
  const handleMapReady = useCallback((map) => { mapRef.current = map }, [])

  // ── Clear weather pill markers ──
  function clearWeatherMarkers() {
    weatherMarkersRef.current.forEach(m => {
      m._popup?.remove()
      m.remove()
    })
    weatherMarkersRef.current = []
  }

  // ── Clear elevation hover marker ──
  function clearElevHoverMarker() {
    if (elevHoverMarkerRef.current) {
      elevHoverMarkerRef.current.remove()
      elevHoverMarkerRef.current = null
    }
  }

  // ── Remove all route map event listeners + hover popup ──────
  function clearRouteListeners() {
    const map = mapRef.current
    if (map) {
      routeListenersRef.current.forEach(({ type, layerId, fn }) => map.off(type, layerId, fn))
    }
    routeListenersRef.current = []
    routeHoverPopupRef.current?.remove()
    routeHoverPopupRef.current = null
  }

  // ── Wire up click-to-select and hover effects on route layers ─
  // Call after every drawRoutesOnMap / redrawRouteLines.
  // Attaches events only to the border layers (9px wide = good click target).
  function addRouteInteractivity(map, activeIdx, numRoutes) {
    clearRouteListeners()
    if (numRoutes < 2) return

    const altIdx      = activeIdx === 0 ? 1 : 0
    const altBorderId = `route-border-${altIdx}`
    const altLineId   = `route-layer-${altIdx}`
    const actBorderId = `route-border-${activeIdx}`
    const routeLabel  = `Click to select Route ${altIdx === 0 ? 'A' : 'B'}`

    const listeners = []
    const addL = (type, layerId, fn) => {
      map.on(type, layerId, fn)
      listeners.push({ type, layerId, fn })
    }

    // Pointer cursor on active route border
    addL('mouseenter', actBorderId, () => { map.getCanvas().style.cursor = 'pointer' })
    addL('mouseleave', actBorderId, () => { map.getCanvas().style.cursor = '' })

    // Hover: thicken alt line + show tooltip
    const onAltEnter = (e) => {
      map.setPaintProperty(altLineId, 'line-width', 5)
      map.setPaintProperty(altLineId, 'line-opacity', 1)
      map.getCanvas().style.cursor = 'pointer'
      routeHoverPopupRef.current?.remove()
      routeHoverPopupRef.current = new mapboxgl.Popup({
        closeButton: false, closeOnClick: false,
        anchor: 'bottom', offset: [0, -10],
        className: 'route-hover-popup', focusAfterOpen: false,
      })
        .setLngLat(e.lngLat)
        .setHTML(
          `<div style="background:#13161e;color:#f0f2f7;font-size:11px;` +
          `font-family:'DM Sans',sans-serif;padding:4px 8px;border-radius:6px;` +
          `border:1px solid rgba(255,255,255,0.12);white-space:nowrap;pointer-events:none">` +
          `${routeLabel}</div>`
        )
        .addTo(map)
    }
    const onAltMove  = (e) => { routeHoverPopupRef.current?.setLngLat(e.lngLat) }
    const onAltLeave = () => {
      map.setPaintProperty(altLineId, 'line-width', 4)
      map.setPaintProperty(altLineId, 'line-opacity', 0.85)
      routeHoverPopupRef.current?.remove()
      routeHoverPopupRef.current = null
      map.getCanvas().style.cursor = ''
    }
    // Click: select the alternate route
    const onAltClick = () => {
      routeHoverPopupRef.current?.remove()
      routeHoverPopupRef.current = null
      map.getCanvas().style.cursor = ''
      handleRouteSelect(altIdx)
    }

    addL('mouseenter', altBorderId, onAltEnter)
    addL('mousemove',  altBorderId, onAltMove)
    addL('mouseleave', altBorderId, onAltLeave)
    addL('click',      altBorderId, onAltClick)

    routeListenersRef.current = listeners
  }

  // ── Load conditions for ALL routes simultaneously ────────────
  // Fetches weather then elevation for every route in parallel,
  // so both cards are scored immediately — no second fetch on route switch.
  async function loadAllConditions(routes, deptDate = new Date()) {
    setConditionsLoading(true)
    setAllConditions([])
    setAllRiskScores([])
    setAllAlerts([])
    allConditionsRef.current = []
    clearWeatherMarkers()
    clearElevHoverMarker()
    try {
      // Pre-compute sample arrays for every route
      const meta = routes.map(r => ({
        coords:             r.geometry.coordinates,
        totalDistanceMiles: r.distance / 1609.344,
        elevSamples:        sampleCoords(r.geometry.coordinates, 80),
        timePoints:         sampleByTime(r.geometry.coordinates, r.duration),
      }))

      // Phase 1 — weather for all routes in parallel
      setLoadingPhase('weather')
      const allWeatherPoints = await Promise.all(
        meta.map(m => fetchWeatherData(m.timePoints, deptDate))
      )

      // Phase 2 — elevation for all routes in parallel
      setLoadingPhase('elevation')
      const allElevMeters = await Promise.all(
        meta.map(m => fetchElevationData(m.elevSamples))
      )

      // Phase 3 — new segment-level risk engine (runs per route sequentially to avoid rate limits)
      setLoadingPhase('scoring')
      const allRiskData = await Promise.all(
        routes.map((r, i) => computeRouteRisk({
          routeCoordinates:   r.geometry.coordinates,
          routeDistanceMiles: r.distance / 1609.344,
          routeDurationSecs:  r.duration,
          departureTime:      deptDate,
          elevationPoints:    allElevMeters[i],
          mapboxSteps:        r.legs?.[0]?.steps ?? [],
          mapboxToken:        TOKEN,
        }))
      )

      // Reverse-geocode all waypoints across all routes in parallel
      const allCityNames = await Promise.all(
        allWeatherPoints.map(pts =>
          Promise.all(pts.map(pt => fetchCityName(pt.coords[0], pt.coords[1])))
        )
      )

      // Assemble per-route condition objects
      const results = meta.map((m, i) => {
        const elevation     = processElevation(allElevMeters[i], m.totalDistanceMiles)
        const weatherPoints = allWeatherPoints[i]
        return {
          elevation,
          weatherPoints,
          notable: getNotableWaypoints(weatherPoints),
          callout: getConditionCallout(weatherPoints),
        }
      })

      const rsList    = allRiskData  // new engine results replace calculateRiskScore
      const alertList = results.map((r, i) => generateAlerts(r.weatherPoints, allCityNames[i], r.elevation))

      setAllConditions(results)
      allConditionsRef.current = results
      setAllRiskScores(rsList)
      setAllAlerts(alertList)

      // Show weather markers for whichever route is currently active
      const map = mapRef.current
      const activeResult = results[activeRouteIdxRef.current]
      if (map && activeResult) {
        addWeatherMarkersToMap(
          map,
          sampleMarkersToShow(activeResult.weatherPoints, 8),
          weatherMarkersRef.current
        )
      }
    } catch {
      setToast('Weather data temporarily unavailable')
    } finally {
      setConditionsLoading(false)
      setLoadingPhase(null)
    }
  }

  // ── Find Route ──
  async function handleFindRoute() {
    const org = originCoordsRef.current
    const dst = destCoordsRef.current
    if (!org || !dst) return

    setNeedsResearch(false)
    setLoading(true)
    setRoutes([])
    setAllConditions([])
    setAllRiskScores([])
    setAllAlerts([])
    allConditionsRef.current = []
    routesRef.current = []
    clearRouteListeners()
    clearWeatherMarkers()
    clearElevHoverMarker()

    try {
      // Build exclude param from active filters
      const excludeParts = [
        avoidTolls    && 'toll',
        avoidHighways && 'motorway',
        avoidFerries  && 'ferry',
      ].filter(Boolean)
      const excludeParam = excludeParts.length > 0 ? `&exclude=${excludeParts.join(',')}` : ''

      const url =
        `https://api.mapbox.com/directions/v5/mapbox/driving/` +
        `${org[0]},${org[1]};${dst[0]},${dst[1]}` +
        `?alternatives=true&geometries=geojson&overview=full&steps=true` +
        `${excludeParam}&access_token=${TOKEN}`

      const res = await fetch(url)
      if (!res.ok) throw new Error(`Route service error (${res.status})`)
      const data = await res.json()
      const fetched = (data.routes ?? []).slice(0, 2)
      if (fetched.length === 0) throw new Error('No routes found between these locations')

      // Toast if any filters are active
      if (excludeParts.length > 0) {
        const names = excludeParts.map(p => p === 'toll' ? 'tolls' : p === 'motorway' ? 'highways' : 'ferries')
        setToast(`Route calculated avoiding ${names.join(', ')}`)
      }

      setRoutes(fetched)
      setActiveRouteIdx(0)
      activeRouteIdxRef.current = 0
      routesRef.current = fetched
      // Auto-collapse sidebar sections so results get more space
      setDeptOpen(false)
      setRouteOptOpen(false)
      setMobileRouteOptOpen(false)
      if (isMobile) setTopBarCollapsed(true)

      const map = mapRef.current
      if (map) {
        drawRoutesOnMap(map, fetched, 0, markersRef.current)
        addRouteInteractivity(map, 0, fetched.length)
        const mA = new mapboxgl.Marker({ element: createRouteMarkerEl('A') }).setLngLat(org).addTo(map)
        const mB = new mapboxgl.Marker({ element: createRouteMarkerEl('B') }).setLngLat(dst).addTo(map)
        markersRef.current.push(mA, mB)
        const bounds = new mapboxgl.LngLatBounds()
        fetched.forEach(r => r.geometry.coordinates.forEach(c => bounds.extend(c)))
        map.fitBounds(bounds, {
          padding: window.innerWidth < 768
            ? { top: 80, bottom: 180, left: 40, right: 40 }
            : 80,
        })
      }

      await loadAllConditions(fetched, useScheduled ? new Date(departureTime) : new Date())
    } catch (err) {
      setToast(err.message || 'Failed to find routes')
    } finally {
      setLoading(false)
    }
  }

  // ── Switch active route ──
  // Uses activeRouteIdxRef (not activeRouteIdx state) for the guard so this
  // function is safe to call from Mapbox event handlers (stale closure safe).
  function handleRouteSelect(idx) {
    const map       = mapRef.current
    const allRoutes = routesRef.current
    if (!map || idx >= allRoutes.length || idx === activeRouteIdxRef.current) return

    setActiveRouteIdx(idx)
    activeRouteIdxRef.current = idx

    const org = originCoordsRef.current
    const dst = destCoordsRef.current
    drawRoutesOnMap(map, allRoutes, idx, markersRef.current)
    if (org && dst) {
      const mA = new mapboxgl.Marker({ element: createRouteMarkerEl('A') }).setLngLat(org).addTo(map)
      const mB = new mapboxgl.Marker({ element: createRouteMarkerEl('B') }).setLngLat(dst).addTo(map)
      markersRef.current.push(mA, mB)
    }

    // Re-wire route interactivity for the new active/alt configuration
    addRouteInteractivity(map, idx, allRoutes.length)

    // Swap weather markers to those already fetched for this route — no re-fetch
    clearWeatherMarkers()
    clearElevHoverMarker()
    const storedResult = allConditionsRef.current[idx]
    if (map && storedResult) {
      addWeatherMarkersToMap(
        map,
        sampleMarkersToShow(storedResult.weatherPoints, 8),
        weatherMarkersRef.current
      )
    }
  }

  // ── Toggle scheduled departure on/off ──
  function handleScheduleToggle(val) {
    setUseScheduled(val)
    // Sync the input to "now" whenever the user enables scheduling so it starts fresh
    if (val) setDepartureTime(toDatetimeLocal(new Date()))
    if (routesRef.current.length > 0) {
      setNeedsResearch(true)
      loadAllConditions(routesRef.current, new Date())
    }
  }

  // ── Scheduled datetime input changed ──
  function handleDepartureTimeChange(value) {
    setDepartureTime(value)
    if (routesRef.current.length > 0) {
      setNeedsResearch(true)
      loadAllConditions(routesRef.current, new Date(value))
    }
  }

  // ── Coord sync ──
  function handleOriginSelect(coords) { setOriginCoords(coords); originCoordsRef.current = coords }
  function handleDestSelect(coords)   { setDestCoords(coords);   destCoordsRef.current   = coords }
  function handleOriginClear()        { setOriginCoords(null);   originCoordsRef.current  = null  }
  function handleDestClear()          { setDestCoords(null);     destCoordsRef.current    = null  }

  // ── Elevation chart hover → map marker ──
  // Uses only refs, so useCallback with [] is safe and keeps identity stable
  const handleElevHover = useCallback((idx) => {
    const map        = mapRef.current
    const route      = routesRef.current[activeRouteIdxRef.current]
    const routeCoords = route?.geometry.coordinates

    if (!map || !routeCoords || idx === null) {
      clearElevHoverMarker()
      return
    }

    const fraction = idx / 79  // 80 samples → index 0..79
    const coordIdx = Math.min(
      Math.round(fraction * (routeCoords.length - 1)),
      routeCoords.length - 1
    )
    const lngLat = routeCoords[coordIdx]

    if (elevHoverMarkerRef.current) {
      elevHoverMarkerRef.current.setLngLat(lngLat)
    } else {
      elevHoverMarkerRef.current = new mapboxgl.Marker({
        element: createElevHoverEl(),
        anchor:  'center',
      }).setLngLat(lngLat).addTo(map)
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Mobile: track window width ──
  useEffect(() => {
    const check = () => setIsMobile(window.innerWidth < 768)
    window.addEventListener('resize', check)
    return () => window.removeEventListener('resize', check)
  }, [])

  // ── Mobile: set initial sheet position without animation ──
  useLayoutEffect(() => {
    const el = sheetRef.current
    if (!el) return
    el.style.transition = 'none'
    el.style.transform  = `translateY(${getSnapPx('peek')}px)`
  }, []) // mount only

  // ── Mobile: animate sheet when sheetPos state changes ──
  useEffect(() => {
    const el = sheetRef.current
    if (!el) return
    el.style.transition = 'transform 0.35s cubic-bezier(0.32,0.72,0,1)'
    el.style.transform  = `translateY(${getSnapPx(sheetPos)}px)`
  }, [sheetPos])

  // ── Mobile: auto-snap to peek after routes are found ──
  // Starts at peek so the user sees the compact route summary; they can drag up for details.
  useEffect(() => {
    if (isMobile && routes.length > 0) setSheetPos('peek')
  }, [routes.length, isMobile]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Mobile: hide sheet instantly when search panel opens; restore when it closes ──
  useEffect(() => {
    if (!isMobile) return
    const el = sheetRef.current
    if (!el) return
    if (!topBarCollapsed) {
      // Search panel expanding — snap sheet to peek with no animation so it
      // doesn't fight with the keyboard or the expanded input area.
      el.style.transition = 'none'
      el.style.transform  = `translateY(${getSnapPx('peek')}px)`
      setSheetPos('peek')
    } else if (routesRef.current.length > 0) {
      // Search panel collapsed and routes exist — slide sheet back to half.
      setSheetPos('half')
    }
  }, [topBarCollapsed, isMobile]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Swap origin ↔ destination ──
  function handleSwap() {
    const tmpText   = originText
    const tmpCoords = originCoordsRef.current
    setOriginText(destText)
    setDestText(tmpText)
    setOriginCoords(destCoordsRef.current)
    setDestCoords(tmpCoords)
    originCoordsRef.current = destCoordsRef.current
    destCoordsRef.current   = tmpCoords
    // Re-fetch with swapped coords if a route is already displayed
    if (routesRef.current.length > 0) handleFindRoute()
  }

  // ── Bottom-sheet touch drag ──
  function handleSheetTouchStart(e) {
    if (!topBarCollapsed) return      // search panel open — block sheet drag
    if (routes.length === 0) return   // no results yet — sheet locked at peek
    const dr  = dragRef.current
    const el  = sheetRef.current
    if (!el) return
    const mat = new DOMMatrix(getComputedStyle(el).transform)
    dr.dragging      = true
    dr.startY        = e.touches[0].clientY
    dr.startTranslate = mat.m42
    dr.lastY         = e.touches[0].clientY
    dr.lastTime      = Date.now()
    dr.velocity      = 0
    el.style.transition = 'none'
  }

  function handleSheetTouchMove(e) {
    const dr = dragRef.current
    if (!dr.dragging) return
    e.preventDefault()
    const now = Date.now()
    const y   = e.touches[0].clientY
    dr.velocity  = (y - dr.lastY) / Math.max(now - dr.lastTime, 1)
    dr.lastY     = y
    dr.lastTime  = now
    const translate = Math.max(0, dr.startTranslate + (y - dr.startY))
    sheetRef.current.style.transform = `translateY(${translate}px)`
  }

  function handleSheetTouchEnd() {
    const dr = dragRef.current
    if (!dr.dragging) return
    dr.dragging = false
    const el  = sheetRef.current
    if (!el) return
    const mat      = new DOMMatrix(getComputedStyle(el).transform)
    const currentY = mat.m42
    const snaps    = { full: 0, half: getSnapPx('half'), peek: getSnapPx('peek') }

    let target
    if (dr.velocity < -0.5) {
      target = currentY > snaps.half ? 'half' : 'full'
    } else if (dr.velocity > 0.5) {
      target = currentY < snaps.half ? 'half' : 'peek'
    } else {
      target = Object.entries(snaps)
        .map(([p, y]) => ({ p, d: Math.abs(currentY - y) }))
        .sort((a, b) => a.d - b.d)[0].p
    }
    el.style.transition = 'transform 0.35s cubic-bezier(0.32,0.72,0,1)'
    el.style.transform  = `translateY(${snaps[target]}px)`
    setSheetPos(target)
  }

  // ── Switch map style ──
  // Active button highlight updates immediately via setActiveStyleId.
  // Route lines are re-added once the style is fully loaded via styledata.
  // A 3-second safety timeout ensures routes always come back even if
  // styledata fires before isStyleLoaded() is true.
  function handleStyleChange(style) {
    const map = mapRef.current
    if (!map || style.id === activeStyleId) return

    // Immediately reflect the new selection in the button group
    setActiveStyleId(style.id)
    map.setStyle(style.url)

    // settled flag prevents double-redraw if both styledata + timeout fire
    let settled = false
    const redraw = () => {
      if (settled) return
      settled = true
      const rs = routesRef.current
      const ai = activeRouteIdxRef.current
      if (rs.length > 0) {
        redrawRouteLines(map, rs, ai)
        addRouteInteractivity(map, ai, rs.length)
      }
    }

    // Primary path: styledata fires repeatedly; wait until style is truly ready
    const onStyleData = () => {
      if (!map.isStyleLoaded()) return
      map.off('styledata', onStyleData)
      redraw()
    }
    map.on('styledata', onStyleData)

    // Safety net: force-redraw after 3 s so routes are never permanently lost
    setTimeout(() => {
      map.off('styledata', onStyleData)
      redraw()
    }, 3000)
  }

  const canSearch = !!(originCoords && destCoords)

  // Derive per-active-route values from the per-route arrays
  const conditions      = allConditions[activeRouteIdx] ?? null
  const riskScore       = allRiskScores[activeRouteIdx] ?? null
  const alerts          = allAlerts[activeRouteIdx]     ?? []
  const routeRiskScores = { 0: allRiskScores[0]?.routeScore, 1: allRiskScores[1]?.routeScore }

  const elev = conditions?.elevation
  const dim  = conditionsLoading ? 0.45 : 1
  // Departure string used purely for display (formatClockTime in the timeline)
  const displayDeptStr = useScheduled ? departureTime : toDatetimeLocal(new Date())

  // ── Mobile render ─────────────────────────────────────────
  if (isMobile) {
    const mobileAlertBorder = (alert) =>
      alert.type === 'clear' ? C.accent : alert.type === 'freeze' ? '#6399ff' : C.riskMid

    return (
      <div style={{ position: 'relative', width: '100vw', height: '100dvh', overflow: 'hidden', background: C.pageBg }}>

        {/* ── Full-screen map ── */}
        <div style={{ position: 'absolute', inset: 0 }}>
          <MapView onMapReady={handleMapReady} />
        </div>

        {/* Layers button — only when top bar is collapsed (route loaded or manually collapsed) */}
        {topBarCollapsed && (
          <div style={{ position: 'fixed', zIndex: 130, top: 100, right: 12 }}>
            <MobileLayersBtn
              activeStyleId={activeStyleId}
              isOpen={stylePickerOpen}
              onClick={() => setStylePickerOpen(v => !v)}
            />
          </div>
        )}

        {/* Style picker overlay — rendered at root level so backdrop covers everything */}
        {stylePickerOpen && (
          <MobileStylePicker
            activeStyleId={activeStyleId}
            onSelect={handleStyleChange}
            onClose={() => setStylePickerOpen(false)}
          />
        )}

        {/* ── Top search bar ── */}
        <div style={{
          position: 'fixed', top: 0, left: 0, right: 0, zIndex: 200,
          background: C.sidebarBg,
          paddingTop: 'env(safe-area-inset-top, 0px)',
          boxShadow: '0 2px 20px rgba(0,0,0,0.55)',
        }}>
          {/* Logo row + chevron */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 14px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ width: 8, height: 8, borderRadius: '50%', background: C.accent, boxShadow: `0 0 10px ${C.accent}`, flexShrink: 0 }} />
              <span style={{ fontSize: 15, fontWeight: 600, color: C.textPri }}>Pathcast</span>
            </div>
            <button
              onClick={() => setTopBarCollapsed(v => !v)}
              style={{ background: 'none', border: 'none', color: C.textSec, cursor: 'pointer', padding: 8, display: 'flex', alignItems: 'center', justifyContent: 'center', minWidth: 44, minHeight: 44 }}
            >
              <ChevronDown size={18} style={{ transition: 'transform 0.2s', transform: topBarCollapsed ? 'rotate(0deg)' : 'rotate(180deg)' }} />
            </button>
          </div>

          {/* Collapsed compact summary — shown when routes loaded and bar is collapsed */}
          {topBarCollapsed && routes.length > 0 && (
            <button
              onClick={() => setTopBarCollapsed(false)}
              style={{
                width: '100%', background: 'none', border: 'none', cursor: 'pointer',
                padding: '0 14px 10px', textAlign: 'left',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
                <span style={{
                  fontSize: 14, color: C.textSec,
                  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                  maxWidth: '42%',
                }}>
                  {originText.split(',')[0]}
                </span>
                <span style={{ color: C.accent, fontSize: 14, flexShrink: 0 }}>→</span>
                <span style={{
                  fontSize: 14, color: C.textSec,
                  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                  flex: 1,
                }}>
                  {destText.split(',')[0]}
                </span>
                <span style={{ fontSize: 12, color: C.accent, flexShrink: 0, marginLeft: 8 }}>
                  Edit
                </span>
              </div>
            </button>
          )}

          {/* Full inputs — shown when expanded (no routes yet, or user tapped Edit) */}
          {!topBarCollapsed && (
            <div style={{ padding: '0 14px 12px', display: 'flex', flexDirection: 'column', gap: 8 }}>
              {/* Origin */}
              <div style={{ position: 'relative' }}>
                <MapPin size={14} style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: C.accent, zIndex: 1 }} />
                <AutocompleteInput
                  placeholder="Starting location"
                  value={originText}
                  onChange={setOriginText}
                  onSelect={handleOriginSelect}
                  onClearCoords={handleOriginClear}
                  inputStyle={{ height: 36, fontSize: 13 }}
                />
              </div>

              {/* Destination + swap */}
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <div style={{ position: 'relative', flex: 1 }}>
                  <MapPin size={14} style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: C.riskHigh, zIndex: 1 }} />
                  <AutocompleteInput
                    placeholder="Destination"
                    value={destText}
                    onChange={setDestText}
                    onSelect={handleDestSelect}
                    onClearCoords={handleDestClear}
                    inputStyle={{ height: 36, fontSize: 13 }}
                  />
                </div>
                <button
                  onClick={handleSwap}
                  title="Swap"
                  style={{ width: 36, height: 36, flexShrink: 0, borderRadius: 8, background: C.elevated, border: `1px solid ${C.borderPri}`, color: C.textSec, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
                >
                  <ArrowUpDown size={15} />
                </button>
              </div>

              {/* Find Route */}
              <Button
                className="w-full"
                disabled={!canSearch || loading}
                onClick={handleFindRoute}
                style={loading
                  ? { minHeight: 44, animation: 'pc-pulse-btn 1.2s ease-in-out infinite' }
                  : { minHeight: 44 }}
              >
                {loading ? 'Analyzing route…' : 'Find Route'}
              </Button>
            </div>
          )}
        </div>

        {/* ── Bottom sheet ── */}
        <div
          ref={sheetRef}
          style={{
            position: 'fixed', left: 0, right: 0, bottom: 0,
            height: '90dvh',
            background: C.sidebarBg,
            borderRadius: '16px 16px 0 0',
            zIndex: 100,
            willChange: 'transform',
            display: 'flex', flexDirection: 'column',
            overflow: 'hidden',
          }}
        >
          {/* ── Drag-handle zone (non-scrollable) ── */}
          <div
            onTouchStart={handleSheetTouchStart}
            onTouchMove={handleSheetTouchMove}
            onTouchEnd={handleSheetTouchEnd}
            style={{ flexShrink: 0, touchAction: 'none' }}
          >
            <div style={{ display: 'flex', justifyContent: 'center', padding: '12px 0 6px' }}>
              <div style={{ width: 40, height: 4, borderRadius: 2, background: 'rgba(255,255,255,0.2)' }} />
            </div>

            {/* Peek content */}
            <div style={{ padding: '2px 16px 12px' }}>
              {routes.length === 0 ? (
                <p style={{ fontSize: 14, color: C.textMuted, textAlign: 'center', paddingTop: 4 }}>
                  {loading ? 'Finding routes…' : 'Search for a route to begin'}
                </p>
              ) : (() => {
                // Parse raw numbers from pre-formatted strings ("3,240 ft" → 3240)
                const parseNum = (str) => parseFloat((str ?? '').replace(/[^0-9.]/g, '')) || 0
                const gainNum  = parseNum(elev?.gainFt)
                const maxNum   = parseNum(elev?.maxFt)
                const showElev = elev && (gainNum > 3000 || maxNum > 6000)
                return (
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                    <div>
                      <p style={{ fontSize: 13, fontWeight: 500, color: C.textPri }}>
                        {activeRouteIdx === 0 ? 'Route A' : 'Route B'}
                        {routes[activeRouteIdx] && ` · ${formatDuration(routes[activeRouteIdx].duration)}`}
                      </p>
                      {showElev && (
                        <p style={{ fontSize: 12, color: C.textSec, marginTop: 2 }}>
                          <span style={{ fontFamily: mono }}>+ {Math.round(gainNum).toLocaleString()} ft</span>
                          <span style={{ color: C.textMuted }}>{' · '}</span>
                          <span style={{ fontFamily: mono }}>▲ {Math.round(maxNum).toLocaleString()} ft</span>
                        </p>
                      )}
                      <p style={{ fontSize: 10, color: C.textMuted, marginTop: showElev ? 1 : 2 }}>Swipe up for details</p>
                    </div>
                    {riskScore && (
                      <span style={{ fontFamily: mono, fontSize: 22, fontWeight: 600, color: scoreColor(riskScore.routeScore) }}>
                        {riskScore.routeScore}
                      </span>
                    )}
                  </div>
                )
              })()}
            </div>
            <div style={{ height: 1, background: C.borderPri }} />
          </div>

          {/* ── Departure row + inline picker (non-scrollable, routes only) ── */}
          {routes.length > 0 && (() => {
            // Format departure label for the row
            const deptDate  = new Date(departureTime)
            const now       = new Date()
            const sameDay   = deptDate.toDateString() === now.toDateString()
            const timeStr   = deptDate.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
            const dateStr   = sameDay ? timeStr
              : `${deptDate.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${timeStr}`
            const deptLabel = useScheduled ? `Depart ${dateStr}` : 'Depart now'

            function openPicker() {
              setPickerScheduled(useScheduled)
              setPickerTime(departureTime)
              setMobilePickerOpen(true)
            }
            function applyPicker() {
              if (pickerScheduled) {
                setUseScheduled(true)
                setDepartureTime(pickerTime)
                if (routesRef.current.length > 0) loadAllConditions(routesRef.current, new Date(pickerTime))
              } else {
                setUseScheduled(false)
                if (routesRef.current.length > 0) loadAllConditions(routesRef.current, new Date())
              }
              setMobilePickerOpen(false)
            }

            return (
              <div style={{ flexShrink: 0, borderBottom: `1px solid ${C.borderPri}` }}>
                {/* Summary row — tap to open picker */}
                <div
                  onClick={mobilePickerOpen ? undefined : openPicker}
                  style={{
                    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                    padding: '12px 16px', background: C.cardBg, cursor: 'pointer',
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <Clock size={14} style={{ color: C.textSec, flexShrink: 0 }} />
                    <span style={{ fontSize: 14, color: C.textPri, fontFamily: "'DM Sans', sans-serif" }}>
                      {deptLabel}
                    </span>
                  </div>
                  <span
                    onClick={(e) => { e.stopPropagation(); mobilePickerOpen ? setMobilePickerOpen(false) : openPicker() }}
                    style={{ fontSize: 12, color: C.accent, cursor: 'pointer' }}
                  >
                    {mobilePickerOpen ? 'Close' : 'Change'}
                  </span>
                </div>

                {/* Inline picker — expands below row */}
                {mobilePickerOpen && (
                  <div style={{ padding: '12px 16px 14px', background: C.cardBg, display: 'flex', flexDirection: 'column', gap: 10 }}>
                    {/* Now / Schedule toggle */}
                    <div
                      onClick={() => setPickerScheduled(v => !v)}
                      style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer', userSelect: 'none' }}
                    >
                      <div style={{
                        width: 32, height: 18, borderRadius: 99, flexShrink: 0,
                        background: pickerScheduled ? C.accent : C.elevated,
                        position: 'relative', transition: 'background 0.2s',
                      }}>
                        <div style={{
                          position: 'absolute', top: 3,
                          left: pickerScheduled ? 17 : 3,
                          width: 12, height: 12, borderRadius: '50%',
                          background: '#fff', transition: 'left 0.2s',
                        }} />
                      </div>
                      <span style={{ fontSize: 13, color: pickerScheduled ? C.textPri : C.textMuted }}>
                        Schedule departure
                      </span>
                    </div>

                    {/* Datetime input */}
                    {pickerScheduled && (
                      <input
                        type="datetime-local"
                        value={pickerTime}
                        onChange={(e) => setPickerTime(e.target.value)}
                        style={{
                          width: '100%', background: C.elevated,
                          border: `1px solid ${C.borderSec}`, borderRadius: 8,
                          color: C.textPri, fontFamily: "'DM Sans', sans-serif",
                          fontSize: 13, padding: '8px 10px', colorScheme: 'dark',
                        }}
                      />
                    )}

                    {/* Set / Cancel */}
                    <div style={{ display: 'flex', gap: 8 }}>
                      <button
                        onClick={applyPicker}
                        style={{
                          flex: 1, padding: '9px 0', borderRadius: 8, border: 'none',
                          background: C.accent, color: '#000',
                          fontSize: 13, fontWeight: 600, cursor: 'pointer',
                          fontFamily: "'DM Sans', sans-serif",
                        }}
                      >
                        Set
                      </button>
                      <button
                        onClick={() => setMobilePickerOpen(false)}
                        style={{
                          flex: 1, padding: '9px 0', borderRadius: 8,
                          border: `1px solid ${C.borderSec}`, background: 'transparent',
                          color: C.textSec, fontSize: 13, cursor: 'pointer',
                          fontFamily: "'DM Sans', sans-serif",
                        }}
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )
          })()}

          {/* ── Scrollable sheet body ── */}
          <div
            className="sidebar-scroll"
            style={{
              flex: 1,
              overflowY: sheetPos === 'full' ? 'auto' : 'hidden',
              padding: '14px 16px',
              display: 'flex', flexDirection: 'column', gap: 14,
            }}
          >
          {routes.length > 0 && <>

            {/* ── Mobile Route Options ── */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
              <AccordionLabel open={mobileRouteOptOpen} onToggle={() => setMobileRouteOptOpen(v => !v)}>
                Route Options
              </AccordionLabel>
              <div style={{
                overflow: 'hidden',
                maxHeight: mobileRouteOptOpen ? 120 : 0,
                transition: 'max-height 0.25s ease',
                display: 'flex', flexDirection: 'column', gap: 8,
              }}>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                  {[
                    { label: 'Avoid Tolls',    active: avoidTolls,    set: setAvoidTolls    },
                    { label: 'Avoid Highways', active: avoidHighways, set: setAvoidHighways  },
                    { label: 'Avoid Ferries',  active: avoidFerries,  set: setAvoidFerries   },
                  ].map(({ label, active, set }) => (
                    <button
                      key={label}
                      onClick={() => {
                        set(v => !v)
                        if (routesRef.current.length > 0) setNeedsResearch(true)
                      }}
                      style={{
                        padding: '5px 11px', borderRadius: 99, fontSize: 11, cursor: 'pointer',
                        fontFamily: "'DM Sans', sans-serif",
                        background: active ? 'rgba(0,212,170,0.1)' : C.cardBg,
                        border:     active ? '1px solid rgba(0,212,170,0.3)' : `1px solid ${C.borderSec}`,
                        color:      active ? C.accent : C.textSec,
                        transition: 'background 0.15s, border-color 0.15s, color 0.15s',
                      }}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                {needsResearch && (
                  <button
                    onClick={handleFindRoute}
                    style={{
                      width: '100%', padding: '7px 0',
                      background: 'transparent',
                      border: `1px solid ${C.accent}`,
                      borderRadius: 8,
                      color: C.accent, fontSize: 10, fontWeight: 600,
                      cursor: 'pointer', fontFamily: "'DM Sans', sans-serif",
                      letterSpacing: '0.05em',
                    }}
                  >
                    Re-search with new settings
                  </button>
                )}
              </div>
            </div>

            {/* Route comparison (compact) */}
            {(() => {
              const sA = allRiskScores[0]?.routeScore
              const sB = allRiskScores[1]?.routeScore
              const bestIdx = (sA === undefined && sB === undefined) ? -1
                : sA === undefined ? 1
                : sB === undefined ? 0
                : sA <= sB ? 0 : 1
              return (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <SectionLabel>Route Comparison</SectionLabel>
                  {[0, 1].map(i => {
                    if (routes.length > 0 && i >= routes.length) return null
                    const isActive = i === activeRouteIdx
                    const route    = routes[i] ?? null
                    const score    = allRiskScores[i]?.routeScore
                    const isBest   = bestIdx === i && routes.length > 0
                    const barColor = score !== undefined ? scoreColor(score) : C.riskLow
                    return (
                      <div
                        key={i}
                        onClick={() => handleRouteSelect(i)}
                        style={{
                          background: C.cardBg, borderRadius: 10, padding: '8px 10px',
                          border: `1px solid ${C.borderPri}`,
                          boxShadow: isActive && routes.length > 0 ? `inset 3px 0 0 ${C.accent}` : 'none',
                          cursor: routes.length > 0 ? 'pointer' : 'default',
                          opacity: routes.length === 0 ? 0.5 : 1,
                          minHeight: 44,
                        }}
                      >
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                            <span style={{ fontSize: 12, fontWeight: 500, color: C.textPri }}>{i === 0 ? 'Route A' : 'Route B'}</span>
                            {isBest && <span style={{ fontSize: 9, color: C.accent, background: 'rgba(0,212,170,0.15)', borderRadius: 99, padding: '1px 6px' }}>Best</span>}
                          </div>
                          <span style={{ fontFamily: mono, fontSize: 13, fontWeight: 500, color: score !== undefined ? scoreColor(score) : C.textMuted }}>
                            {score !== undefined ? score : '--'}
                          </span>
                        </div>
                        <p style={{ fontSize: 10, color: C.textMuted, marginBottom: 6 }}>
                          {route ? `${formatDuration(route.duration)} · ${formatDistance(route.distance)}` : '— · —'}
                        </p>
                        <div style={{ height: 3, background: C.elevated, borderRadius: 2 }}>
                          <div style={{ height: '100%', width: score !== undefined ? `${score}%` : '0%', background: barColor, borderRadius: 2, transition: 'width 0.4s' }} />
                        </div>
                      </div>
                    )
                  })}
                </div>
              )
            })()}

            {/* Compact risk score */}
            {(() => {
              const total = riskScore?.routeScore
              const color = total !== undefined ? scoreColor(total) : C.textMuted
              const label = total !== undefined ? riskLabel(total) : '--'
              return (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  <SectionLabel>Risk Score</SectionLabel>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
                    <span style={{ fontFamily: mono, fontSize: 44, fontWeight: 300, color, lineHeight: 1 }}>
                      {total !== undefined ? total : '--'}
                    </span>
                    <div style={{ flex: 1 }}>
                      <p style={{ fontSize: 11, fontWeight: 600, color, letterSpacing: '0.06em', textTransform: 'uppercase', marginBottom: 6 }}>{label}</p>
                      <div style={{ height: 5, background: C.elevated, borderRadius: 3 }}>
                        <div style={{ height: '100%', width: total !== undefined ? `${total}%` : '0%', background: color, borderRadius: 3, transition: 'width 0.4s' }} />
                      </div>
                    </div>
                  </div>
                </div>
              )
            })()}

            {/* ── Full content (only when sheet is fully open) ── */}
            {sheetPos === 'full' ? (
              <>
                {/* Risk factor breakdown */}
                {riskScore && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                    <SectionLabel>Risk Breakdown</SectionLabel>
                    {RISK_FACTORS.map((factor) => {
                      const score    = riskScore?.factors?.[factor.key] ?? 0
                      const barColor = scoreColor(score)
                      return (
                        <div key={factor.key} style={{ marginBottom: 2 }}>
                          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 2 }}>
                            <span style={{ fontSize: 10, color: C.textMuted }}>
                              {factor.label}
                              <span style={{ color: C.textMuted, opacity: 0.6, marginLeft: 3 }}>({factor.weight}%)</span>
                            </span>
                            <span style={{ fontFamily: mono, fontSize: 10, color: barColor }}>{score}</span>
                          </div>
                          <div style={{ height: 3, background: C.elevated, borderRadius: 2 }}>
                            <div style={{ height: '100%', width: `${score}%`, background: barColor, borderRadius: 2, transition: 'width 0.4s' }} />
                          </div>
                        </div>
                      )
                    })}
                  </div>
                )}

                {/* Route alerts (full, with subtitles) */}
                {alerts.length > 0 && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                    <SectionLabel>Route Alerts</SectionLabel>
                    {alerts.map((alert, i) => (
                      <div key={i} style={{
                        background: alert.type === 'clear' ? 'rgba(0,212,170,0.08)' : alert.type === 'freeze' ? 'rgba(99,153,255,0.1)' : 'rgba(245,166,35,0.1)',
                        borderLeft: `2px solid ${mobileAlertBorder(alert)}`,
                        borderRadius: 8, padding: '8px 10px', display: 'flex', gap: 8,
                      }}>
                        <span style={{ fontSize: 14, flexShrink: 0, lineHeight: 1.2 }}>{alert.emoji}</span>
                        <div style={{ minWidth: 0 }}>
                          <p style={{ fontSize: 11, fontWeight: 600, color: C.textPri, marginBottom: 2 }}>{alert.title}</p>
                          <p style={{ fontSize: 10, color: C.textSec, lineHeight: 1.4 }}>{alert.subtitle}</p>
                          {alert.meta && <p style={{ fontFamily: mono, fontSize: 9, color: C.textMuted, marginTop: 3 }}>{alert.meta}</p>}
                        </div>
                      </div>
                    ))}
                  </div>
                )}

                {/* Weather timeline */}
                {conditions?.weatherPoints && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    <SectionLabel>Weather Timeline</SectionLabel>
                    {conditions.weatherPoints.map((pt, i) => {
                      const isLast = i === conditions.weatherPoints.length - 1
                      return (
                        <div key={i} style={{ display: 'flex' }}>
                          <div style={{ width: 48, flexShrink: 0, paddingRight: 8, paddingTop: 12, textAlign: 'right' }}>
                            <span style={{ fontFamily: mono, fontSize: 10, color: C.textMuted }}>{formatTimeline(pt.timeSeconds)}</span>
                          </div>
                          <div style={{ width: 14, flexShrink: 0, position: 'relative' }}>
                            <div style={{ position: 'absolute', top: 13, left: '50%', transform: 'translateX(-50%)', width: 6, height: 6, borderRadius: '50%', background: C.accent }} />
                            {!isLast && <div style={{ position: 'absolute', top: 19, bottom: 0, left: '50%', transform: 'translateX(-50%)', width: 1, background: 'rgba(0,212,170,0.28)' }} />}
                          </div>
                          <div style={{ flex: 1, paddingLeft: 6, paddingBottom: isLast ? 0 : 6, paddingTop: 4 }}>
                            <div style={{ background: C.cardBg, border: `1px solid ${C.borderPri}`, borderLeft: `2px solid ${waypointRiskColor(pt)}`, borderRadius: 8, padding: '8px 10px', minHeight: 44 }}>
                              <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 2 }}>
                                <p style={{ fontSize: 12, color: C.textPri, fontWeight: 500 }}>{pt.emoji} {pt.label}</p>
                                <span style={{ fontFamily: mono, fontSize: 10, color: C.textMuted }}>{formatClockTime(displayDeptStr, pt.timeSeconds)}</span>
                              </div>
                              <p style={{ fontSize: 10, color: C.textSec }}>{pt.tempF}°F · {pt.windMph} mph · {pt.precipIn}in · {pt.visibilityMi}mi vis.</p>
                            </div>
                          </div>
                        </div>
                      )
                    })}
                    {/* Arrived */}
                    <div style={{ display: 'flex', alignItems: 'center' }}>
                      <div style={{ width: 48, flexShrink: 0, paddingRight: 8, textAlign: 'right' }}>
                        <span style={{ fontFamily: mono, fontSize: 10, color: C.textMuted }}>{formatTimeline(routes[activeRouteIdx]?.duration ?? 0)}</span>
                      </div>
                      <div style={{ width: 14, flexShrink: 0, display: 'flex', justifyContent: 'center' }}>
                        <MapPin size={10} style={{ color: C.riskHigh }} />
                      </div>
                      <div style={{ flex: 1, paddingLeft: 6, display: 'flex', alignItems: 'baseline', gap: 6 }}>
                        <span style={{ fontSize: 11, color: C.textMuted }}>Arrived</span>
                        {routes[activeRouteIdx] && (
                          <span style={{ fontFamily: mono, fontSize: 10, color: C.textMuted }}>{formatClockTime(displayDeptStr, routes[activeRouteIdx].duration)}</span>
                        )}
                      </div>
                    </div>
                  </div>
                )}

                {/* Elevation profile */}
                {elev && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                      <SectionLabel>Elevation Profile</SectionLabel>
                      <div style={{ display: 'flex', gap: 14 }}>
                        {[['Gain', elev.gainFt], ['Max', elev.maxFt], ['Min', elev.minFt]].map(([s, v]) => (
                          <div key={s} style={{ display: 'flex', alignItems: 'baseline', gap: 4 }}>
                            <span style={{ fontSize: 9, fontWeight: 600, letterSpacing: '0.08em', textTransform: 'uppercase', color: C.textMuted }}>{s}</span>
                            <span style={{ fontFamily: mono, fontSize: 10, color: C.textSec }}>{v}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                    <div style={{ height: 120 }}>
                      <ElevationChart
                        elevFeet={elev.elevFeet}
                        distanceLabels={elev.distanceLabels}
                        onHoverIdx={handleElevHover}
                      />
                    </div>
                  </div>
                )}

                {/* Open In */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8, paddingBottom: 'max(env(safe-area-inset-bottom), 16px)' }}>
                  <SectionLabel>Open In</SectionLabel>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8 }}>
                    {NAV_APPS.map(app => (
                      <NavBtn
                        key={app.id}
                        label={app.label}
                        labelColor={app.labelColor}
                        tooltip={originCoords && destCoords ? app.tooltip : 'Search a route first'}
                        disabled={!originCoords || !destCoords}
                        onClick={() => app.handler(originCoords, destCoords)}
                      />
                    ))}
                  </div>
                  <p style={{ fontSize: 11, color: C.textMuted, textAlign: 'center', marginTop: 8 }}>
                    Navigation opens with your start &amp; end points. Route may vary from Pathcast&apos;s recommendation.
                  </p>
                </div>
              </>
            ) : (
              /* Condensed alerts in peek / half state */
              alerts.length > 0 && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <SectionLabel>Route Alerts</SectionLabel>
                  {alerts.map((alert, i) => (
                    <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 10, borderLeft: `2px solid ${mobileAlertBorder(alert)}`, paddingLeft: 10, minHeight: 36 }}>
                      <span style={{ fontSize: 14 }}>{alert.emoji}</span>
                      <div>
                        <p style={{ fontSize: 11, fontWeight: 500, color: C.textPri }}>{alert.title}</p>
                        {alert.meta && <p style={{ fontFamily: mono, fontSize: 9, color: C.textMuted }}>{alert.meta}</p>}
                      </div>
                    </div>
                  ))}
                </div>
              )
            )}

          </>}{/* end routes.length > 0 */}
          </div>{/* end scrollable body */}
        </div>{/* end bottom sheet */}

        <Toast message={toast} onDismiss={() => setToast(null)} />
      </div>
    )
  }

  // ── Desktop render ─────────────────────────────────────────
  return (
    <div style={{ display: 'flex', height: '100vh', width: '100vw', overflow: 'hidden', background: C.pageBg }}>

      {/* ── Left Sidebar ─────────────────────────────────────── */}
      <aside
        className="sidebar-scroll"
        style={{
          width: 390, flexShrink: 0, display: 'flex', flexDirection: 'column',
          overflowY: 'auto', background: C.sidebarBg,
          borderRight: `1px solid ${C.borderPri}`,
        }}
      >
        {/* Logo */}
        <header style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '18px 20px', borderBottom: `1px solid ${C.borderPri}`, flexShrink: 0 }}>
          <span style={{ width: 8, height: 8, borderRadius: '50%', background: C.accent, boxShadow: `0 0 10px ${C.accent}`, flexShrink: 0 }} />
          <div>
            <h1 style={{ fontSize: 16, fontWeight: 600, color: C.textPri, lineHeight: 1.2 }}>Pathcast</h1>
            <p style={{ fontSize: 12, color: C.textSec, marginTop: 1 }}>Weather-intelligent routing</p>
          </div>
        </header>

        {/* ── Route Inputs ── */}
        <section style={{ padding: '20px 16px 16px', display: 'flex', flexDirection: 'column', gap: 12, flexShrink: 0 }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <SectionLabel>Start</SectionLabel>
            <AutocompleteInput
              placeholder="Enter starting location"
              value={originText}
              onChange={setOriginText}
              onSelect={handleOriginSelect}
              onClearCoords={handleOriginClear}
              iconEl={<MapPin size={14} style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', color: C.accent, zIndex: 1 }} />}
            />
          </div>
          {/* Swap button — sits in the gap between origin and dest */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: -4, marginBottom: -4 }}>
            <div style={{ flex: 1, height: 1, background: C.borderPri }} />
            <button
              onClick={handleSwap}
              title="Swap origin and destination"
              style={{
                width: 26, height: 26, borderRadius: '50%',
                background: C.elevated, border: `1px solid ${C.borderSec}`,
                color: C.textSec, cursor: 'pointer',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                flexShrink: 0, transition: 'color 0.15s, border-color 0.15s',
              }}
              onMouseEnter={e => { e.currentTarget.style.color = C.textPri; e.currentTarget.style.borderColor = C.accent }}
              onMouseLeave={e => { e.currentTarget.style.color = C.textSec; e.currentTarget.style.borderColor = C.borderSec }}
            >
              <ArrowUpDown size={12} />
            </button>
            <div style={{ flex: 1, height: 1, background: C.borderPri }} />
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <SectionLabel>Destination</SectionLabel>
            <AutocompleteInput
              placeholder="Enter destination"
              value={destText}
              onChange={setDestText}
              onSelect={handleDestSelect}
              onClearCoords={handleDestClear}
              iconEl={<MapPin size={14} style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', color: C.riskHigh, zIndex: 1 }} />}
            />
          </div>
          <Button
            className="w-full"
            disabled={!canSearch || loading}
            onClick={handleFindRoute}
            style={loading ? { animation: 'pc-pulse-btn 1.2s ease-in-out infinite' } : {}}
          >
            {loading ? 'Analyzing route...' : 'Find Route'}
          </Button>
        </section>

        <Divider />

        {/* ── Departure Time ── */}
        <section style={{ padding: '20px 16px 16px', display: 'flex', flexDirection: 'column', gap: 0, flexShrink: 0 }}>
          <AccordionLabel open={deptOpen} onToggle={() => setDeptOpen(v => !v)}>
            Departure Time
          </AccordionLabel>

          {/* Collapsible content */}
          <div style={{
            overflow: 'hidden',
            maxHeight: deptOpen ? 220 : 0,
            transition: 'max-height 0.25s ease',
            display: 'flex', flexDirection: 'column', gap: 10,
          }}>
            {/* Toggle row */}
            <div
              onClick={() => handleScheduleToggle(!useScheduled)}
              style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer', userSelect: 'none' }}
            >
              {/* Pill */}
              <div style={{
                width: 32, height: 18, borderRadius: 99, flexShrink: 0,
                background: useScheduled ? C.accent : C.elevated,
                position: 'relative', transition: 'background 0.2s',
              }}>
                <div style={{
                  position: 'absolute', top: 3,
                  left: useScheduled ? 17 : 3,
                  width: 12, height: 12, borderRadius: '50%',
                  background: '#fff', transition: 'left 0.2s',
                }} />
              </div>
              <span style={{ fontSize: 12, color: useScheduled ? C.textPri : C.textMuted }}>
                Schedule departure
              </span>
            </div>

            {/* Datetime input — only visible when scheduling is on */}
            {useScheduled && (
              <input
                type="datetime-local"
                value={departureTime}
                onChange={(e) => handleDepartureTimeChange(e.target.value)}
                style={{
                  width: '100%',
                  background: C.cardBg,
                  border: `1px solid ${C.borderSec}`,
                  borderRadius: 8,
                  color: C.textPri,
                  fontFamily: "'DM Sans', sans-serif",
                  fontSize: 13,
                  padding: '8px 10px',
                  colorScheme: 'dark',
                }}
              />
            )}

            {/* Re-search button — shown when settings changed after a route was found */}
            {needsResearch && routes.length > 0 && (
              <button
                onClick={handleFindRoute}
                style={{
                  width: '100%', padding: '7px 0', marginTop: 2,
                  background: 'transparent',
                  border: `1px solid ${C.accent}`,
                  borderRadius: 8,
                  color: C.accent, fontSize: 10, fontWeight: 600,
                  cursor: 'pointer', fontFamily: "'DM Sans', sans-serif",
                  letterSpacing: '0.05em',
                  transition: 'background 0.15s',
                }}
                onMouseEnter={e => e.currentTarget.style.background = 'rgba(0,212,170,0.08)'}
                onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
              >
                Re-search with new settings
              </button>
            )}
          </div>
        </section>

        <Divider />

        {/* ── Route Options ── */}
        <section style={{ padding: '20px 16px 16px', display: 'flex', flexDirection: 'column', gap: 0, flexShrink: 0 }}>
          <AccordionLabel open={routeOptOpen} onToggle={() => setRouteOptOpen(v => !v)}>
            Route Options
          </AccordionLabel>

          {/* Collapsible content */}
          <div style={{
            overflow: 'hidden',
            maxHeight: routeOptOpen ? 120 : 0,
            transition: 'max-height 0.25s ease',
            display: 'flex', flexDirection: 'column', gap: 10,
          }}>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {[
                { label: 'Avoid Tolls',     active: avoidTolls,    set: setAvoidTolls    },
                { label: 'Avoid Highways',  active: avoidHighways, set: setAvoidHighways  },
                { label: 'Avoid Ferries',   active: avoidFerries,  set: setAvoidFerries   },
              ].map(({ label, active, set }) => (
                <button
                  key={label}
                  onClick={() => {
                    set(v => !v)
                    if (routesRef.current.length > 0) setNeedsResearch(true)
                  }}
                  style={{
                    padding: '5px 12px', borderRadius: 99, fontSize: 12, cursor: 'pointer',
                    fontFamily: "'DM Sans', sans-serif",
                    background: active ? 'rgba(0,212,170,0.1)' : C.cardBg,
                    border:     active ? '1px solid rgba(0,212,170,0.3)' : `1px solid ${C.borderSec}`,
                    color:      active ? C.accent : C.textSec,
                    transition: 'background 0.15s, border-color 0.15s, color 0.15s',
                  }}
                >
                  {label}
                </button>
              ))}
            </div>

            {/* Re-search button */}
            {needsResearch && routes.length > 0 && (
              <button
                onClick={handleFindRoute}
                style={{
                  width: '100%', padding: '7px 0',
                  background: 'transparent',
                  border: `1px solid ${C.accent}`,
                  borderRadius: 8,
                  color: C.accent, fontSize: 10, fontWeight: 600,
                  cursor: 'pointer', fontFamily: "'DM Sans', sans-serif",
                  letterSpacing: '0.05em',
                  transition: 'background 0.15s',
                }}
                onMouseEnter={e => e.currentTarget.style.background = 'rgba(0,212,170,0.08)'}
                onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
              >
                Re-search with new settings
              </button>
            )}
          </div>
        </section>

        <Divider />

        {/* ── Route Comparison ── */}
        {(() => {
          // Determine which route has the lower (better) risk score
          const sA = routeRiskScores[0], sB = routeRiskScores[1]
          const bestIdx = (sA === undefined && sB === undefined) ? -1
                        : sA === undefined ? 1
                        : sB === undefined ? 0
                        : sA <= sB ? 0 : 1

          // Trade-off text (only when both routes are loaded with scores)
          let tradeoffText = null
          if (sA !== undefined && sB !== undefined && routes.length === 2) {
            const ptDiff  = Math.abs(sA - sB)
            const minDiff = Math.round(Math.abs(routes[0].duration - routes[1].duration) / 60)
            const saferName  = sA <= sB ? 'Route A' : 'Route B'
            const saferIdx   = sA <= sB ? 0 : 1
            const slowerIdx  = routes[0].duration >= routes[1].duration ? 0 : 1
            if (ptDiff > 0) {
              tradeoffText = saferIdx === slowerIdx
                ? `${saferName} is ${ptDiff} points safer but ${minDiff} min longer`
                : `${saferName} is ${ptDiff} points safer`
            }
          }

          return (
            <section style={{ padding: '20px 16px 16px', display: 'flex', flexDirection: 'column', gap: 8, flexShrink: 0 }}>
              <SectionLabel>Route Comparison</SectionLabel>
              {[0, 1].map(i => {
                if (routes.length > 0 && i >= routes.length) return null
                const isActive  = i === activeRouteIdx
                const route     = routes[i] ?? null
                const score     = routeRiskScores[i]
                const isBest    = bestIdx === i && routes.length > 0
                const barColor  = score !== undefined ? scoreColor(score) : C.riskLow
                return (
                  <div
                    key={i}
                    onClick={() => handleRouteSelect(i)}
                    style={{
                      background: isActive && routes.length > 0 ? '#1e2433' : C.cardBg,
                      borderRadius: 12, padding: '14px',
                      border: '1px solid transparent',
                      borderLeft: isActive && routes.length > 0 ? `3px solid ${C.accent}` : '3px solid transparent',
                      cursor: routes.length > 0 ? 'pointer' : 'default',
                      opacity: routes.length === 0 ? 0.5 : 1,
                      transition: 'background 0.15s, border-color 0.15s',
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                        <span style={{ fontSize: 15, fontWeight: 600, color: C.textPri }}>
                          {i === 0 ? 'Route A' : 'Route B'}
                        </span>
                        {isBest && (
                          <span style={{ fontSize: 11, color: C.accent, background: 'rgba(0,212,170,0.15)', borderRadius: 99, padding: '3px 10px', fontWeight: 500 }}>
                            Best
                          </span>
                        )}
                      </div>
                      <span style={{ fontFamily: mono, fontSize: 18, fontWeight: 600, color: score !== undefined ? scoreColor(score) : C.textMuted }}>
                        {score !== undefined ? score : '--'}
                      </span>
                    </div>
                    <p style={{ fontSize: 12, color: C.textMuted, marginBottom: 8 }}>
                      {route
                        ? `${formatDuration(route.duration)}  ·  ${formatDistance(route.distance)}`
                        : '— · — · —'}
                    </p>
                    <div style={{ height: 6, background: C.elevated, borderRadius: 3 }}>
                      <div style={{ height: '100%', width: score !== undefined ? `${score}%` : '0%', background: barColor, borderRadius: 3, transition: 'width 0.4s' }} />
                    </div>
                  </div>
                )
              })}
              {tradeoffText && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, background: 'rgba(0,212,170,0.05)', border: '1px solid rgba(0,212,170,0.1)', borderRadius: 8, padding: '8px 12px', marginTop: 2 }}>
                  <span style={{ color: C.accent, fontSize: 13, flexShrink: 0, lineHeight: 1 }}>ℹ</span>
                  <p style={{ fontSize: 13, color: C.textSec }}>{tradeoffText}</p>
                </div>
              )}
            </section>
          )
        })()}

        <Divider />

        {/* ── Risk Score ── */}
        <section style={{ padding: '20px 16px 16px', display: 'flex', flexDirection: 'column', gap: 12, flexShrink: 0 }}>
          <SectionLabel>Risk Score</SectionLabel>
          {(() => {
            const total  = riskScore?.routeScore
            const color  = total !== undefined ? scoreColor(total) : C.textMuted
            const label  = total !== undefined ? riskLabel(total)  : 'Select a route'
            const expl   = riskScore?.explanation ?? null
            return (
              <>
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4 }}>
                  <span style={{ fontFamily: mono, fontSize: 56, fontWeight: 300, color, lineHeight: 1 }}>
                    {total !== undefined ? total : '--'}
                  </span>
                  <p style={{ fontSize: 13, fontWeight: 600, letterSpacing: '0.12em', textTransform: 'uppercase', color }}>
                    {label}
                  </p>
                  <div style={{ width: '100%', height: 8, background: C.elevated, borderRadius: 4, marginTop: 4 }}>
                    <div style={{ height: '100%', width: total !== undefined ? `${total}%` : '0%', background: color, borderRadius: 4, transition: 'width 0.4s' }} />
                  </div>
                </div>
                {expl && (
                  <p style={{ fontSize: 12, color: C.textSec, lineHeight: 1.6, textAlign: 'center', padding: '10px 14px' }}>{expl}</p>
                )}
                <div style={{ display: 'flex', flexDirection: 'column' }}>
                  {RISK_FACTORS.map((factor) => {
                    const score    = riskScore?.factors?.[factor.key] ?? 0
                    const barColor = scoreColor(score)
                    return (
                      <div key={factor.key} style={{ marginBottom: 8 }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 3 }}>
                          <span style={{ fontSize: 11, color: C.textSec }}>
                            {factor.label}
                            <span style={{ color: C.textMuted, marginLeft: 4 }}>({factor.weight}%)</span>
                          </span>
                          <span style={{ fontFamily: mono, fontSize: 11, color: scoreColor(score) }}>
                            {score}
                          </span>
                        </div>
                        <div style={{ height: 5, borderRadius: 3, background: 'rgba(255,255,255,0.07)' }}>
                          <div style={{
                            height: '100%', borderRadius: 3,
                            width: `${score}%`,
                            background: scoreColor(score),
                            transition: 'width 0.4s ease',
                          }} />
                        </div>
                      </div>
                    )
                  })}
                </div>
              </>
            )
          })()}
        </section>

        <Divider />

        {/* ── ROUTE ALERTS ── */}
        {(routes.length > 0 || conditionsLoading) && (
          <>
            <section style={{ padding: '20px 16px 16px', display: 'flex', flexDirection: 'column', gap: 8, flexShrink: 0, opacity: dim, transition: 'opacity 0.25s' }}>
              <SectionLabel>Route Alerts</SectionLabel>
              {conditionsLoading ? (
                <p style={{ fontSize: 12, color: C.textMuted }}>Analyzing weather data…</p>
              ) : (
                <div>
                  {alerts.map((alert, i) => {
                    const isClear  = alert.type === 'clear'
                    const isFreeze = alert.type === 'freeze'
                    const bg     = isClear  ? 'rgba(0,212,170,0.08)'  : isFreeze ? 'rgba(99,153,255,0.1)'  : 'rgba(245,166,35,0.1)'
                    const border = isClear  ? C.accent                : isFreeze ? '#6399ff'               : C.riskMid
                    return (
                      <div key={i} style={{
                        background: bg,
                        borderLeft: `2px solid ${border}`,
                        borderRadius: 8,
                        padding: '8px 10px',
                        marginBottom: i < alerts.length - 1 ? 6 : 0,
                        display: 'flex',
                        gap: 8,
                      }}>
                        <span style={{ fontSize: 14, flexShrink: 0, lineHeight: 1.2 }}>{alert.emoji}</span>
                        <div style={{ minWidth: 0 }}>
                          <p style={{ fontSize: 11, fontWeight: 600, color: C.textPri, marginBottom: 2 }}>
                            {alert.title}
                          </p>
                          <p style={{ fontSize: 10, color: C.textSec, lineHeight: 1.4 }}>
                            {alert.subtitle}
                          </p>
                          {alert.meta && (
                            <p style={{ fontFamily: mono, fontSize: 9, color: C.textMuted, marginTop: 3 }}>
                              {alert.meta}
                            </p>
                          )}
                        </div>
                      </div>
                    )
                  })}
                </div>
              )}
            </section>
            <Divider />
          </>
        )}

        {/* ── WEATHER TIMELINE ── */}
        <section
          style={{ padding: '20px 16px 16px', display: 'flex', flexDirection: 'column', gap: 10, flexShrink: 0, opacity: dim, transition: 'opacity 0.25s' }}
        >
          <SectionLabel>Weather Timeline</SectionLabel>

          {conditions?.weatherPoints ? (
            <div
              className="timeline-scroll"
              style={{ maxHeight: 280, overflowY: 'auto' }}
            >
              {conditions.weatherPoints.map((pt, i) => {
                const isLast = i === conditions.weatherPoints.length - 1
                return (
                  <div key={i} style={{ display: 'flex' }}>
                    {/* Time label column */}
                    <div style={{
                      width: 52, flexShrink: 0,
                      paddingRight: 10, paddingTop: 13,
                      textAlign: 'right',
                    }}>
                      <span style={{ fontFamily: mono, fontSize: 11, color: C.textMuted, lineHeight: 1 }}>
                        {formatTimeline(pt.timeSeconds)}
                      </span>
                    </div>

                    {/* Spine: dot + vertical line */}
                    <div style={{ width: 16, flexShrink: 0, position: 'relative' }}>
                      {/* Dot */}
                      <div style={{
                        position: 'absolute', top: 15,
                        left: '50%', transform: 'translateX(-50%)',
                        width: 7, height: 7, borderRadius: '50%',
                        background: C.accent,
                      }} />
                      {/* Connector line to next item */}
                      {!isLast && (
                        <div style={{
                          position: 'absolute',
                          top: 22, bottom: 0,
                          left: '50%', transform: 'translateX(-50%)',
                          width: 1,
                          background: 'rgba(0,212,170,0.28)',
                        }} />
                      )}
                    </div>

                    {/* Weather card */}
                    <div style={{ flex: 1, paddingLeft: 8, paddingBottom: isLast ? 0 : 8, paddingTop: 6 }}>
                      <div style={{
                        background: C.cardBg,
                        border: `1px solid ${C.borderPri}`,
                        borderLeft: `2px solid ${waypointRiskColor(pt)}`,
                        borderRadius: 8,
                        padding: '10px 14px',
                      }}>
                        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 4 }}>
                          <p style={{ fontSize: 13, color: C.textPri, fontWeight: 500 }}>
                            {pt.emoji} {pt.label}
                          </p>
                          <span style={{ fontFamily: mono, fontSize: 11, color: C.textMuted, flexShrink: 0, marginLeft: 6 }}>
                            {formatClockTime(displayDeptStr, pt.timeSeconds)}
                          </span>
                        </div>
                        <p style={{ fontSize: 11, color: C.textSec, lineHeight: 1.5 }}>
                          {pt.tempF}°F · {pt.windMph} mph · {pt.precipIn}in · {pt.visibilityMi}mi vis.
                        </p>
                      </div>
                    </div>
                  </div>
                )
              })}

              {/* Arrived row */}
              <div style={{ display: 'flex', alignItems: 'center', marginTop: 6 }}>
                <div style={{ width: 52, flexShrink: 0, paddingRight: 10, textAlign: 'right' }}>
                  <span style={{ fontFamily: mono, fontSize: 10, color: C.textMuted }}>
                    {formatTimeline(routes[activeRouteIdx]?.duration ?? 0)}
                  </span>
                </div>
                <div style={{ width: 16, flexShrink: 0, display: 'flex', justifyContent: 'center' }}>
                  <MapPin size={11} style={{ color: C.riskHigh }} />
                </div>
                <div style={{ flex: 1, paddingLeft: 8, display: 'flex', alignItems: 'baseline', gap: 6 }}>
                  <span style={{ fontSize: 11, color: C.textMuted }}>Arrived</span>
                  {routes[activeRouteIdx] && (
                    <span style={{ fontFamily: mono, fontSize: 10, color: C.textMuted }}>
                      {formatClockTime(displayDeptStr, routes[activeRouteIdx].duration)}
                    </span>
                  )}
                </div>
              </div>
            </div>
          ) : (
            <p style={{ fontSize: 12, color: C.textMuted }}>
              {conditionsLoading
                ? loadingPhase === 'weather'   ? 'Fetching weather…'
                : loadingPhase === 'elevation' ? 'Loading elevation…'
                : loadingPhase === 'scoring'   ? 'Scoring route…'
                : 'Analyzing conditions…'
                : 'Find a route to see weather conditions.'}
            </p>
          )}
        </section>

        <Divider />

        {/* ── Navigation Handoff ── */}
        <section style={{ padding: '20px 16px 16px', display: 'flex', flexDirection: 'column', gap: 8, flexShrink: 0 }}>
          <SectionLabel>Open In</SectionLabel>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8 }}>
            {NAV_APPS.map(app => (
              <NavBtn
                key={app.id}
                label={app.label}
                labelColor={app.labelColor}
                tooltip={originCoords && destCoords ? app.tooltip : 'Search a route first'}
                disabled={!originCoords || !destCoords}
                onClick={() => app.handler(originCoords, destCoords)}
              />
            ))}
          </div>
          <p style={{ fontSize: 11, color: C.textMuted, textAlign: 'center', marginTop: 8 }}>
            Navigation opens with your start &amp; end points. Route may vary from Pathcast&apos;s recommendation.
          </p>
        </section>

      </aside>

      {/* ── Right Column ─────────────────────────────────────── */}
      <main style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>

        {/* Map */}
        <div style={{ flex: 1, position: 'relative', background: C.pageBg }}>
          <MapView onMapReady={handleMapReady} />

          {/* Style toggle — top-right of map */}
          <div style={{ position: 'absolute', top: 12, right: 12, zIndex: 10 }}>
            <MapStyleToggle activeStyleId={activeStyleId} onStyleChange={handleStyleChange} />
          </div>

          {routes.length === 0 && !loading && (
            <div style={{
              position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column',
              alignItems: 'center', justifyContent: 'center', gap: 12, pointerEvents: 'none',
            }}>
              <Navigation size={32} style={{ color: C.textPri, opacity: 0.15 }} />
              <div style={{ textAlign: 'center' }}>
                <p style={{ fontSize: 13, color: C.textMuted }}>Enter a route to see the map</p>
                <p style={{ fontSize: 11, color: '#3a3f50', marginTop: 4 }}>Weather · Elevation · Risk score</p>
              </div>
            </div>
          )}
        </div>

        {/* Elevation Panel */}
        <div style={{
          flexShrink: 0, height: 180,
          background: C.sidebarBg, borderTop: `1px solid ${C.borderPri}`,
          display: 'flex', flexDirection: 'column',
          opacity: dim, transition: 'opacity 0.25s',
        }}>
          {/* Header */}
          <div style={{
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            padding: '10px 20px', borderBottom: `1px solid ${C.borderPri}`, flexShrink: 0,
          }}>
            <SectionLabel>Elevation Profile</SectionLabel>
            <div style={{ display: 'flex', gap: 20 }}>
              {[['Gain', elev?.gainFt ?? '--'], ['Max', elev?.maxFt ?? '--'], ['Min', elev?.minFt ?? '--']].map(([stat, val]) => (
                <div key={stat} style={{ display: 'flex', alignItems: 'baseline', gap: 5 }}>
                  <span style={{ fontSize: 10, fontWeight: 600, letterSpacing: '0.08em', textTransform: 'uppercase', color: C.textMuted }}>{stat}</span>
                  <span style={{ fontFamily: mono, fontSize: 12, fontWeight: 500, color: C.textSec }}>{val}</span>
                </div>
              ))}
            </div>
          </div>

          {/* Chart */}
          <div style={{ flex: 1, padding: '6px 16px 8px', minHeight: 0 }}>
            {elev ? (
              <ElevationChart
                elevFeet={elev.elevFeet}
                distanceLabels={elev.distanceLabels}
                onHoverIdx={handleElevHover}
              />
            ) : (
              <div style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <p style={{ fontSize: 12, color: C.textMuted }}>
                  {conditionsLoading ? 'Loading elevation data…' : 'Elevation profile will appear here'}
                </p>
              </div>
            )}
          </div>
        </div>

      </main>

      <Toast message={toast} onDismiss={() => setToast(null)} />
    </div>
  )
}
