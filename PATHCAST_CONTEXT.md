# Pathcast — App Architecture & Development Context
**Last updated: April 2026**
**Live URL: https://pathcast.vercel.app**
**GitHub: https://github.com/ddesai56/Pathcast**

---

## What is Pathcast?

Pathcast is a weather-intelligent route planning web app that helps drivers understand the risk of their journey before they leave. Where Google Maps tells you *how* to get somewhere, Pathcast tells you *whether* and *when* it's safe to go.

**Core value proposition:**
> "You always leave knowing exactly what's ahead — and you always take the smartest route."

**Target users (v1):** Everyday car drivers making road trips or long drives in the US and Canada.

**Future users (v2+):** EV owners, motorcyclists, cyclists, hikers, commercial drivers.

---

## Tech Stack

| Layer | Technology | Notes |
|---|---|---|
| Framework | React + Vite | Bootstrapped with `npm create vite@latest` |
| Mapping | Mapbox GL JS v3.3.0 | Dark map style, routing, geocoding, markers |
| Routing | Mapbox Directions API | Fetches up to 2 alternate routes with GeoJSON geometry |
| Geocoding | Mapbox Geocoding API | Autocomplete on origin/destination inputs |
| Weather | Open-Meteo Hourly API | Free, no API key. Fetches forecasted weather at arrival time per waypoint |
| Elevation | Open-Meteo Elevation API | Free, no API key. Samples 80 points along route |
| Charts | Chart.js + react-chartjs-2 | Elevation profile chart |
| Styling | Tailwind CSS + custom CSS | Dark theme, DM Sans + DM Mono fonts |
| UI Components | shadcn/ui | Buttons, inputs, basic components |
| Hosting | Vercel (free Hobby plan) | Auto-deploys on every GitHub push |
| Version control | GitHub | Repo: github.com/ddesai56/Pathcast |

---

## Environment Variables

| Variable | Purpose |
|---|---|
| `VITE_MAPBOX_TOKEN` | Mapbox API token — set in Vercel dashboard and local .env file |

Open-Meteo requires no API key.

---

## Project Structure

```
pathcast/
├── public/
├── src/
│   ├── components/          # React components
│   │   ├── Map.jsx          # Mapbox map, route lines, markers, weather emoji markers
│   │   ├── Sidebar.jsx      # Left sidebar (desktop) / bottom sheet (mobile)
│   │   ├── RouteCards.jsx   # Route A / Route B comparison cards
│   │   ├── RiskScore.jsx    # Risk score panel with factor breakdown
│   │   ├── RouteAlerts.jsx  # Smart weather alert cards
│   │   ├── WeatherTimeline.jsx  # 45-min interval weather cards
│   │   └── ElevationChart.jsx   # Chart.js elevation profile
│   ├── hooks/
│   │   └── useGeocoding.js  # Mapbox autocomplete logic
│   ├── utils/
│   │   ├── format.js        # Unit formatting (mi/km, ft/m, mph/kph)
│   │   └── weatherElevation.js  # Open-Meteo API calls
│   ├── styles/
│   ├── App.jsx              # Root component, layout
│   ├── main.jsx
│   └── index.css
├── .env                     # Local env vars (not committed to GitHub)
├── .gitignore               # Includes .env
├── vite.config.js
└── package.json
```

---

## Design System

**Color palette:**
| Token | Value | Usage |
|---|---|---|
| Page background | `#0d0f14` | App background |
| Sidebar background | `#13161e` | Sidebar, bottom sheet |
| Card background | `#1a1e28` | All cards and inputs |
| Elevated surface | `#222736` | Hover states |
| Primary border | `rgba(255,255,255,0.07)` | Section dividers |
| Secondary border | `rgba(255,255,255,0.12)` | Input borders |
| Primary text | `#f0f2f7` | Main content |
| Secondary text | `#8b90a0` | Labels, subtitles |
| Muted text | `#555b6e` | Timestamps, hints |
| Accent / teal | `#00d4aa` | Logo, buttons, active states |
| Risk low | `#00d4aa` | Score 0–30 |
| Risk medium | `#f5a623` | Score 31–60 |
| Risk high | `#ff4757` | Score 61–100 |
| Freeze alert | `#6399ff` | Temperature/ice alerts |

**Typography:**
- Body font: `DM Sans` (Google Fonts)
- Monospace / numbers: `DM Mono` (Google Fonts)
- Used for: risk scores, timestamps, elevation values, distances

---

## Layout

### Desktop (768px and above)
```
┌─────────────────────────────────────────────────┐
│  TOPBAR: Logo | not used on desktop             │
├──────────────┬──────────────────────────────────┤
│              │                                  │
│   SIDEBAR    │         MAP (Mapbox)             │
│   (380px)    │                                  │
│              │                                  │
│  - Inputs    ├──────────────────────────────────┤
│  - Departure │    ELEVATION PROFILE (Chart.js)  │
│  - Routes    │                                  │
│  - Risk score│                                  │
│  - Alerts    │                                  │
│  - Weather   │                                  │
│  - Open in   │                                  │
└──────────────┴──────────────────────────────────┘
```

### Mobile (under 768px)
```
┌─────────────────────┐
│  TOP BAR (fixed)    │  ← Logo + inputs + Find Route
│  Start input        │
│  Destination input  │
│  Find Route btn     │
├─────────────────────┤
│                     │
│    MAP (full        │  ← Mapbox fills remaining space
│    screen)          │
│                     │
├─────────────────────┤
│ ── drag handle ──   │  ← Bottom sheet (slides up)
│ Route A · 6h 17m    │  ← Peek state (120px)
│ Swipe up for details│
│                     │
│ [Route cards]       │  ← Half state (50% screen)
│ [Risk score]        │
│ [Route alerts]      │
│                     │
│ [Full breakdown]    │  ← Full state (90% screen)
│ [Weather timeline]  │
│ [Open in buttons]   │
└─────────────────────┘
```

---

## Core Features — Current State

### ✅ Complete and working

#### Map
- **Mapbox GL JS map** — full-screen interactive base, dark style default
- **4 map styles** — Dark, Satellite, Streets, Outdoors via frosted pill toggle; Dark and Satellite grouped as recommended
- **Route lines** — active route: teal solid line with black border; alternate route: gray dashed with white border for contrast on all map styles
- **Route endpoint markers** — teal circular DOM markers labeled A and B
- **Route interactivity** — hover over alternate route thickens it and shows tooltip; clicking switches active route
- **Weather waypoint markers** — up to 8 emoji pill markers along active route; hover shows popup with temp, wind, precip
- **Elevation hover marker** — amber pulsing dot tracks cursor on elevation chart onto map in real time
- **Map style persistence** — all route lines and markers redrawn after style switch via styledata event with 3-second safety timeout

#### Route Planning
- **Autocomplete inputs** — Mapbox Geocoding API, debounced, keyboard navigable
- **Swap button** — swaps origin and destination text and coordinates
- **Find Route** — Mapbox Directions API, up to 2 alternate routes fetched simultaneously
- **Departure time toggle** — Leave now vs scheduled departure; weather offset by actual arrival time per waypoint
- **Loading states** — button pulses during fetch with phase labels

#### Conditions & Analysis
- **Route comparison cards** — duration, distance, risk score; active card has teal left border; Best badge; trade-off insight pill
- **Risk score** — 0–100 in DM Mono, color-coded, label, progress bar, plain English explanation, 5-factor breakdown bars
- **Route alerts** — rain, wind, freezing, visibility alerts with city name via reverse geocoding; all-clear card when no hazards
- **Weather timeline** — vertical timeline, one card per 45-min interval, calculated from departure time, Arrived row at bottom
- **Elevation profile** — Chart.js line chart, gradient fill, hover crosshair, pulsing amber map dot, Gain/Max/Min stats

#### Navigation Handoff
- **Google Maps, Apple Maps, Waze buttons** — deep links with origin/destination; mobile uses native URI schemes with web fallback
- **Disabled state** until route is searched
- **Disclaimer** explaining route may vary

#### Mobile Layout
- **Responsive at 768px** — full-screen map + bottom sheet
- **3 snap positions** — peek (120px), half (50%), full (90%)
- **Drag-to-snap** — touch and mouse with momentum detection
- **Collapsible top bar** — hides inputs to maximize map space

#### Visual Design
- **Section titles** — 12px uppercase with 3px teal left accent bar
- **Sidebar hierarchy** — clear contrast between section titles, card content, and secondary labels
- **Dark theme** — #0d0f14 background, #13161e sidebar, #1a1e28 cards, #00d4aa accent

### 🚧 In progress
- **Mobile layout refinement** — being handled in dedicated mobile chat
- **Risk score algorithm** — being refined in dedicated algorithm chat

### 📋 Planned (not yet built)
- **Departure time optimizer** — suggest best departure window to minimize risk score
- **Color-coded route line** — green/amber/red segments on map based on risk per segment
- **User accounts** — save routes, history (requires Supabase backend)
- **Freemium paywall** — Pro features gated behind subscription
- **SEO / landing page** — route-specific pages for organic traffic
- **iOS app** — native SwiftUI app (future, requires iOS developer)

---

## Risk Score Algorithm

**Overall score:** Weighted sum of 5 factors, each 0–100. Final score rounded to nearest integer, capped at 100.

```
Score = (Precipitation × 0.35) + (Elevation × 0.25) + 
        (Visibility × 0.20) + (Wind × 0.10) + (Temperature × 0.10)
```

**Factor scoring (linear interpolation between breakpoints):**

| Factor | Input | Breakpoints |
|---|---|---|
| Precipitation | Max precip across waypoints (mm) | 0→0, 0.5→20, 1→35, 2→55, 3→70, 5→85, 8+→100 |
| Elevation | Total gain (meters) | 0→0, 300→15, 700→35, 1200→55, 1800→72, 2500→85, 3500+→100 |
| Visibility | Min visibility across waypoints (miles) | 47+→0, 20→5, 10→15, 5→35, 2→60, 1→80, 0.25→100 |
| Wind | Max wind across waypoints (mph) | 0→0, 10→8, 20→20, 30→38, 45→60, 60→80, 75+→100 |
| Temperature | Min temp across waypoints (°F) | 40+→0, 35→15, 32→40, 28→60, 20→78, 10→90, 0→100 |

**Risk labels:**
- 0–30 = Low risk (green #00d4aa)
- 31–60 = Moderate risk (amber #f5a623)
- 61–80 = Elevated risk (red #ff4757)
- 81–100 = High risk (red #ff4757)

**Note:** The algorithm is still being refined. A separate chat is dedicated to improving it using NHTSA/FHWA road safety data and adding compound hazard multipliers (e.g. rain + steep descent = worse than additive sum).

---

## Route Alerts Logic

Alerts are generated automatically after weather data is fetched. Rules:

| Condition | Trigger | Alert type |
|---|---|---|
| Rain | Any waypoint precip > 0.1mm | Amber warning |
| Strong wind | Any waypoint wind > 20mph | Amber warning |
| Freezing | Any waypoint temp < 35°F | Blue freeze alert |
| Low visibility | Any waypoint visibility < 3mi | Amber warning |
| All clear | No conditions triggered | Green all-clear |

Each alert includes: emoji icon, title with time (e.g. "Rain at 2h 15m"), subtitle with location from Mapbox reverse geocoding, timestamp + city in DM Mono.

---

## API Usage

### Mapbox Directions API
```
GET https://api.mapbox.com/directions/v5/mapbox/driving/{lng1},{lat1};{lng2},{lat2}
  ?alternatives=true
  &geometries=geojson
  &overview=full
  &steps=false
  &access_token={token}
```
Returns up to 2 routes with full GeoJSON geometry, duration (seconds), distance (meters).

### Mapbox Geocoding API (autocomplete)
```
GET https://api.mapbox.com/geocoding/v5/mapbox.places/{query}.json
  ?access_token={token}
  &autocomplete=true
  &limit=5
  &country=us,ca
```

### Mapbox Reverse Geocoding (for alert city names)
```
GET https://api.mapbox.com/geocoding/v5/mapbox.places/{lng},{lat}.json
  ?types=place
  &access_token={token}
```

### Open-Meteo Weather (hourly forecast at arrival time)
```
GET https://api.open-meteo.com/v1/forecast
  ?latitude={lat}
  &longitude={lng}
  &hourly=temperature_2m,precipitation,wind_speed_10m,visibility,weather_code
  &wind_speed_unit=kmh
  &timezone=auto
  &forecast_days=2
```
Weather is fetched for each 45-minute waypoint. The arrival time at each waypoint is calculated as: departure time + (waypoint index × 45 minutes). The matching hour is found in the hourly arrays.

### Open-Meteo Elevation
```
GET https://api.open-meteo.com/v1/elevation
  ?latitude={lat1,lat2,...lat80}
  &longitude={lng1,lng2,...lng80}
```
Returns array of elevation values in meters for up to 80 coordinates per request.

---

## Deployment Workflow

```bash
# Make changes locally
npm run dev   # test at localhost:5173

# Deploy to production
git add .
git commit -m "describe change"
git push      # Vercel auto-deploys in ~60 seconds
```

Vercel project is connected to GitHub repo `ddesai56/Pathcast`, main branch. Every push to main triggers a production deployment automatically.

---

## Development Chats

This project uses multiple Claude chats, each focused on a specific area:

| Chat | Focus |
|---|---|
| **Webapp dev** (this chat) | Main development, features, deployment |
| **Risk score algorithm** | Deep dive into formula, calibration, NHTSA data |
| **Mobile layout** | Mobile-specific UI refinements, bottom sheet UX |

---

## Known Issues / Bugs

1. **Weather fetch errors** — Intermittent, could not be consistently reproduced. Monitor in production.
2. **Mobile bottom sheet** — Hard to collapse once fully expanded. Being addressed in mobile chat.
3. **Elevation chart on Safari** — Requires a click before hover events fire on the canvas. Chrome works correctly. Fix in progress.
4. **Elevation on mobile** — Chart interaction is limited on small screens. Being addressed in mobile chat.

---

## Monetization Plan (Post-MVP)

**Free tier:**
- Unlimited route searches
- Basic risk score (number + label)
- Weather summary (3 waypoints)
- Standard map view

**Pathcast Pro ($4.99/month or $39.99/year):**
- Full risk breakdown (5 factors)
- Full weather timeline (all 45-min waypoints)
- Departure time optimizer
- Saved routes
- EV mode (future)
- Ad-free

---

## Future — iOS App

Planned for after the web app is stable and has real users. Will be a native SwiftUI app built by a hired iOS developer, using the web app as the functional spec. Key addition over web: push notifications for route weather changes.

Navigation (turn-by-turn) will NOT be built — Pathcast hands off to Apple Maps / Google Maps / Waze via deep links after route selection.

---

*This document should be kept up to date as the app evolves. Add it to the root of the Pathcast GitHub repo so all development chats have access to it.*
