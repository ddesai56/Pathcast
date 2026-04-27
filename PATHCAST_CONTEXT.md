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

## How This App Is Built

**Dhruv (the founder) has no coding background.** The entire codebase is written by Claude using **Claude Code** — the agentic coding tool available in the Claude Mac app.

**Development workflow:**
1. Dhruv describes a feature or fix in plain English in Claude Code
2. Claude Code reads the existing files, writes or edits the code, and installs dependencies
3. Dhruv tests at `localhost:5173` in the browser
4. When happy, pushes to GitHub → Vercel auto-deploys in ~60 seconds

**Multiple Claude chats are used for different concerns:**

| Chat | Focus |
|---|---|
| **Webapp dev** | Main development, features, UI, deployment — primary chat |
| **Risk score algorithm** | Deep dive into formula, NHTSA data, compound hazard multipliers |
| **Mobile layout** | Mobile-specific UI refinements, bottom sheet UX |

**When starting a new chat:** Upload this `PATHCAST_CONTEXT.md` file at the start so Claude has full context without re-explanation.

**Important for Claude Code:** Always read this file before making changes. Do not restructure the project or rename files without asking first. Preserve all existing functionality when adding new features.

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

Open-Meteo requires no API key. The `.env` file is gitignored and never committed.

---

## Project Structure

```
pathcast/
├── public/
├── src/
│   ├── components/
│   │   ├── Map.jsx                # Mapbox map, route lines, markers, weather emoji markers
│   │   ├── Sidebar.jsx            # Left sidebar (desktop) / bottom sheet (mobile)
│   │   ├── RouteCards.jsx         # Route A / Route B comparison cards
│   │   ├── RiskScore.jsx          # Risk score panel with factor breakdown
│   │   ├── RouteAlerts.jsx        # Smart weather alert cards
│   │   ├── WeatherTimeline.jsx    # 45-min interval weather cards
│   │   ├── ElevationChart.jsx     # Chart.js elevation profile
│   │   ├── AutocompleteInput.jsx  # Geocoding search with debounce + dropdown
│   │   ├── MapStyleToggle.jsx     # Frosted pill with 4 styles + group divider
│   │   ├── NavBtn.jsx             # Brand-colored navigation handoff button
│   │   ├── SectionLabel.jsx       # 3px teal bar + 12px uppercase label
│   │   └── Toast.jsx              # Transient error/info notification
│   ├── hooks/
│   │   └── useGeocoding.js        # Mapbox autocomplete logic
│   ├── utils/
│   │   ├── format.js              # formatDuration, formatDistance, unit conversions
│   │   ├── weatherElevation.js    # Open-Meteo API calls, weather processing, computeRouteRisk orchestrator
│   │   └── riskEngine.js          # Segment scoring engine — factors, multipliers, rollup, explanation
│   ├── styles/
│   ├── App.jsx                    # Root component, layout
│   ├── main.jsx
│   └── index.css
├── PATHCAST_CONTEXT.md            # This file — shared across all dev chats
├── .env                           # Local env vars (not committed to GitHub)
├── .gitignore
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
| Active card background | `#1e2433` | Selected route card |
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
- Section titles: 12px, uppercase, letter-spacing 0.1em, color #f0f2f7, with 3px teal left accent bar

---

## Layout

### Desktop (768px and above)
```
┌──────────────────────────────────────────────────────┐
│  SIDEBAR (390px fixed)  │  MAP (Mapbox, flex)        │
│                         │                            │
│  • Logo + tagline       │  • Full interactive map    │
│  • Start input          │  • Route A (teal solid)    │
│  • Swap button          │  • Route B (gray dashed)   │
│  • Destination input    │  • A/B endpoint markers    │
│  • Find Route button    │  • Weather emoji markers   │
│  • Departure time ▾     │  • Map style switcher      │
│  • Route options ▾      │  • Zoom controls           │
│  • Route comparison     ├────────────────────────────┤
│  • Risk score           │  ELEVATION PROFILE         │
│  • Route alerts         │  (Chart.js, 160px height)  │
│  • Weather timeline     │                            │
│  • Open in buttons      │                            │
└──────────────────────────────────────────────────────┘
```

**Collapsible sections:** After Find Route is clicked, DEPARTURE TIME and ROUTE OPTIONS auto-collapse. User can re-expand by clicking the section title. A "Re-search with new settings" button appears if settings are changed after search.

### Mobile (under 768px)
```
┌─────────────────────┐
│  TOP BAR (fixed)    │  ← Logo + inputs + Find Route + chevron to collapse
│  Start input        │
│  Swap button        │
│  Destination input  │
│  Find Route btn     │
├─────────────────────┤
│                     │
│    MAP (full        │  ← Mapbox fills all remaining space
│    screen)          │  ← Weather markers, route lines visible
│                     │
├─────────────────────┤
│ ── drag handle ──   │  ← Bottom sheet
│ Route A · 6h 17m    │  ← Peek state (120px)
│ Swipe up for details│
│                     │
│ [Departure time]    │  ← Half state (50% screen)
│ [Route options]     │
│ [Route cards]       │
│ [Risk score]        │
│                     │
│ [Risk breakdown]    │  ← Full state (90% screen)
│ [Route alerts]      │
│ [Weather timeline]  │
│ [Open in buttons]   │
└─────────────────────┘
```

---

## Core Features — Current State

### ✅ Complete and working

#### Map
- **Mapbox GL JS map** — full-screen interactive base, dark style default
- **4 map styles** — Dark, Satellite, Streets, Outdoors via frosted pill toggle; Dark and Satellite have teal tint to signal recommended
- **Route lines** — active route: teal solid 5px line with black border; alternate route: gray dashed with white border, visible on all map styles including satellite
- **Route endpoint markers** — teal circular DOM markers labeled A and B
- **Route interactivity** — hover over alternate route thickens it and shows "Click to select" tooltip; clicking switches active route and updates all sidebar panels
- **Weather waypoint markers** — up to 8 emoji pill markers along active route; hover shows dark popup with temp, wind, precip; nighttime emojis (🌙 for clear night, 🌥️ for cloudy night)
- **Elevation hover marker** — amber pulsing dot tracks cursor on elevation chart onto map in real time
- **Map style persistence** — all route lines and markers redrawn after style switch via styledata event with 3-second safety timeout

#### Route Planning
- **Autocomplete inputs** — Mapbox Geocoding API, debounced 300ms, US + Canada, keyboard navigable dropdown
- **Swap button** — swaps origin and destination text and coordinates; re-fetches route if one is already loaded
- **Find Route** — Mapbox Directions API, up to 2 alternate routes fetched simultaneously; both routes pre-fetch weather and elevation in parallel
- **Route options** — Avoid Tolls / Avoid Highways / Avoid Ferries chip toggles; passed as `exclude` parameter to Mapbox API; available on both desktop and mobile
- **Departure time toggle** — collapsible section; Leave now vs scheduled departure with datetime picker; weather offset by actual arrival time per waypoint
- **Auto-collapse after search** — Departure Time and Route Options sections auto-collapse after Find Route to give risk score more space
- **Loading states** — Find Route button shows phase labels: "Finding routes…" → "Fetching weather…" → "Loading elevation…" → "Scoring route…"

#### Conditions & Analysis
- **Route comparison cards** — duration, distance, risk score; active card: #1e2433 background with 3px teal left border; inactive: #1a1e28; Best badge on lower-risk route; trade-off insight pill with ℹ icon
- **Risk score** — 0–100 in DM Mono 56px, color-coded green/amber/red, label, 8px progress bar, plain English explanation, 6-factor breakdown with bars (Precipitation 33%, Grade 22%, Visibility 20%, Temperature 12%, Wind 8%, Road class 5%)
- **Route alerts** — up to 4 alert types: rain, wind, freezing, low visibility; each with colored left border, emoji, bold title, city name from reverse geocoding, driving advice; all-clear card when no hazards
- **Weather timeline** — vertical timeline with teal spine, one card per 45-min interval, arrival time calculated from departure, condition + emoji + temp/wind/precip/visibility row, Arrived row at bottom
- **Nighttime emoji logic** — waypoints arriving before 6am or after 8pm show 🌙 (clear) or 🌥️ (cloudy) instead of daytime equivalents
- **Elevation profile** — Chart.js line chart, teal gradient fill, hover crosshair (amber dashed line), pulsing amber map dot on hover, Gain/Max/Min stats in DM Mono

#### Navigation Handoff
- **Google Maps** — opens `google.com/maps/dir/` with origin + destination coordinates
- **Apple Maps** — uses `maps://` deep link on iOS, `maps.apple.com` on desktop
- **Waze** — uses `waze://` deep link on mobile with 1.5s web fallback, `waze.com/ul` on desktop
- **Button styling** — brand colors: Google blue #4285F4, Apple white #f0f2f7, Waze cyan #33CCFF; text only, no logos; disabled at 40% opacity until route is searched
- **Disclaimer** — "Navigation opens with your start & end points. Route may vary from Pathcast's recommendation."

#### Mobile Layout
- **Responsive at 768px** — full-screen map + bottom sheet overlay
- **3 snap positions** — peek (120px), half (50%), full (90%)
- **Drag-to-snap** — touch and mouse drag with velocity/momentum detection
- **Collapsible top bar** — chevron hides/shows inputs to maximize map space
- **Route options on mobile** — Avoid chips in bottom sheet

#### Visual Design
- **Section titles** — 12px, uppercase, letter-spacing 0.1em, color #f0f2f7, with 3px teal left accent bar
- **Card hierarchy** — active cards #1e2433, inactive cards #1a1e28, clearly distinct from sidebar #13161e
- **Dark theme throughout** — #0d0f14 page, #13161e sidebar, teal #00d4aa accent

### 🚧 In progress
- **Mobile layout refinement** — bottom sheet collapse UX, being handled in dedicated mobile chat
- **Elevation chart on Safari** — requires click before hover works; Chrome works correctly

### 📋 Planned (not yet built)
- **Departure time optimizer** — "Suggest best departure time" button analyzing next 12 hours
- **Color-coded route line** — green/amber/red segments on map based on risk per segment
- **User accounts** — save routes, history (requires Supabase backend)
- **Freemium paywall** — Pro features gated behind subscription
- **SEO / landing page** — route-specific pages for organic traffic
- **iOS app** — native SwiftUI app (future, requires iOS developer)

---

## Risk Score Algorithm

The risk engine lives in `src/utils/riskEngine.js` and is orchestrated by `computeRouteRisk()` in `weatherElevation.js`. It runs as a 4-layer pipeline after every route fetch.

---

### Pipeline Overview

```
RAW ROUTE DATA (Mapbox + Open-Meteo)
         │
         ▼
LAYER 1 — ADAPTIVE SEGMENTATION
  Slice route into geographic segments based on total distance:
  ≤150 mi → 5-mile segments
  150–400 mi → 8-mile segments
  >400 mi → 10-mile segments
  Each segment: midpoint coord, arrival time, elevation diff, road class
         │
         ▼
LAYER 2 — PER-SEGMENT FACTOR SCORING
  For each segment, score 6 factors independently (each 0–100):
  Precipitation (33%) · Grade (22%) · Visibility (20%)
  Temperature (12%) · Wind (8%) · Road class (5%)
  → Weighted sum = base segment score
         │
         ▼
LAYER 3 — COMPOUND HAZARD MULTIPLIERS
  If multiple dangerous conditions coincide in same segment,
  apply a multiplier to that segment's score (highest wins, no stacking).
  Score capped at 100 after multiplier.
         │
         ▼
LAYER 4 — ROUTE-LEVEL ROLLUP
  Route score = (P90 of length-weighted segment scores × 0.75)
              + peak danger bonus (if any segment > 70)
  Capped at 100.
         │
         ▼
OUTPUTS
  routeScore (0–100) · segment array (for map coloring)
  aggregated factors (worst per factor) · plain-English explanation
```

---

### Layer 1 — Adaptive Segmentation

Route geometry (GeoJSON coordinates from Mapbox) is walked using the Haversine formula to place sample points at exact distance intervals. Each sample point records:
- `coord` — [lng, lat] at that point
- `distanceFromStartMeters` — cumulative distance along route
- `arrivalTime` — departure time + (distance / average speed)

Segment interval adapts to route length to balance accuracy against Open-Meteo API call volume:

| Route length | Segment interval | Typical segment count |
|---|---|---|
| ≤ 150 miles | 5 miles | up to ~30 |
| 150–400 miles | 8 miles | ~20–50 |
| > 400 miles | 10 miles | ~40–60 |

Weather is fetched once per segment midpoint (separate from the 45-min timeline waypoints). Elevation is interpolated from the existing 80-point elevation array — no extra API call needed.

---

### Layer 2 — Factor Scoring

Each factor uses **linear interpolation** between calibrated breakpoints. The `interpolate(value, breakpoints)` function walks the breakpoint table and draws a straight line between the two surrounding values.

All breakpoints are grounded in NHTSA/FHWA adverse-condition crash rate data.

#### Precipitation
Input: `precipitation` in mm from Open-Meteo (raw hourly value at arrival time)

| mm | Score |
|---|---|
| 0 | 0 |
| 0.5 | 20 |
| 1 | 35 |
| 2 | 55 |
| 3 | 70 |
| 5 | 85 |
| ≥ 8 | 100 |

#### Grade (road slope)
Input: `|elevation diff| / segment length × 100` = percent slope

| % grade | Score |
|---|---|
| 0% | 0 |
| 1% | 5 |
| 2% | 15 |
| 4% | 35 |
| 6% | 55 |
| 8% | 72 |
| 10% | 85 |
| ≥ 13% | 100 |

Note: elevation diff is computed per segment from the 80-point Open-Meteo elevation array using linear interpolation. This measures actual slope, not total trip gain.

#### Visibility
Input: `visibility` in meters from Open-Meteo → converted to km internally

| km | Score |
|---|---|
| ≥ 75 | 0 |
| 32 | 5 |
| 16 | 15 |
| 8 | 35 |
| 3.2 | 60 |
| 1.6 | 80 |
| ≤ 0.4 | 100 |

#### Temperature
Input: `temperature_2m` in °C from Open-Meteo. Risk is near and below freezing only — above 4°C scores 0.

| °C | Score |
|---|---|
| ≥ 4 | 0 |
| 2 | 8 |
| 0 (freezing) | 40 |
| -2 | 60 |
| -6 | 78 |
| -12 | 90 |
| ≤ -20 | 100 |

#### Wind
Input: `wind_speed_10m` in km/h from Open-Meteo (requested with `wind_speed_unit=kmh`)

| km/h | Score |
|---|---|
| 0 | 0 |
| 16 | 8 |
| 32 | 20 |
| 48 | 38 |
| 72 | 60 |
| 96 | 80 |
| ≥ 120 | 100 |

#### Road Class
Input: `step.intersections[0].mapbox_streets_v8.class` from Mapbox Directions step objects (requires `steps=true` in API call). Fixed lookup table — not interpolated.

| Mapbox class | Score |
|---|---|
| motorway | 5 |
| trunk | 8 |
| primary | 12 |
| secondary | 18 |
| tertiary | 25 |
| residential | 35 |
| service | 40 |
| ferry | 50 |
| track | 60 |
| unknown | 15 (default) |

#### Weighted sum
```
baseScore = (precipitation × 0.33) + (grade × 0.22) + (visibility × 0.20)
          + (temperature × 0.12) + (wind × 0.08) + (roadClass × 0.05)
```
Weights sum to 1.00.

---

### Layer 3 — Compound Hazard Multipliers

Applied after the base score. Only the **highest applicable multiplier fires** — they do not stack multiplicatively (which would over-penalize). Score is capped at 100 after multiplier is applied.

Grounded in NHTSA/FHWA compound-condition crash rate data.

| Condition | Trigger | Multiplier |
|---|---|---|
| Rain + steep descent | precip ≥ 1mm AND grade ≥ 4% | ×1.45 |
| Ice + steep grade | temp ≤ 0°C AND grade ≥ 3% | ×1.40 |
| Night + rain + low visibility | not daytime AND precip ≥ 0.5mm AND vis ≤ 3.2km | ×1.35 |
| Low visibility on high-speed road | vis ≤ 1.6km AND road class is motorway/trunk/primary | ×1.30 |

Daytime = arrival hour between 6 and 20. Night = before 6 or after 20.

---

### Layer 4 — Route-Level Rollup

Segment scores are aggregated into a single route score using a **P90 + peak danger bonus** formula. This avoids two failure modes:
- **Simple average** — a long safe highway dilutes a dangerous mountain pass
- **Max score** — one mild rain waypoint at the start makes the whole route look terrible

```
routeScore = (P90_score × 0.75) + peakBonus
peakBonus  = max(0, peakSegmentScore − 70) × 0.5   [only if any segment > 70]
routeScore = min(100, round(routeScore))
```

**P90** is the length-weighted 90th percentile — segments are sorted by score, then cumulative length is walked until 90% of total route distance is covered. That segment's score is the P90. This means 90% of the route is at or below that risk level.

**Peak bonus** ensures a genuinely dangerous segment (score > 70) still registers in the route score. A segment scoring 90 adds `(90 − 70) × 0.5 = 10` bonus points on top of the P90.

---

### Factor Panel Aggregation

The 6-factor breakdown shown in the UI uses `aggregateFactors()`, which takes the **maximum (worst) value per factor across all segments**:

```javascript
result[key] = Math.max(...segments.map(s => s.factors[key]))
```

This answers "what was the worst moment on this drive for each dimension?" — which is what a dispatcher needs to know. A dispatcher doesn't care about average wind; they care about peak wind on the route.

---

### Plain-English Explanation

Generated by `generateExplanation()` based on route score + aggregated factors:

| Route score | Explanation pattern |
|---|---|
| 0–15 | "Conditions look clear. Safe to drive." |
| 16–30 | "Minor weather along the route. Drive normally and stay alert." |
| 31–60 | "Moderate risk near [location]. Watch for [factors]. Reduce speed in affected areas." |
| 61–80 | "Elevated risk near [location] — [factors]. Consider delaying or taking extra precautions." |
| 81–100 | "High risk near [location]. Dangerous conditions: [factors]. Strongly consider delaying this trip." |

Location is the reverse-geocoded city name of the worst-scoring segment (1 Mapbox geocoding API call per route, only for the worst segment).

Factors included in the explanation if their aggregated score ≥ 40: precipitation, grade, visibility, temperature, wind.

---

### Risk Labels and Colors

| Score range | Label | Color |
|---|---|---|
| 0–30 | Low risk | `#00d4aa` (teal) |
| 31–60 | Moderate risk | `#f5a623` (amber) |
| 61–80 | Elevated risk | `#ff4757` (red) |
| 81–100 | High risk | `#ff4757` (red) |

---

### Data Sources Summary

| Data | Source | API call timing |
|---|---|---|
| Weather per segment | Open-Meteo hourly forecast | Fetched at segment midpoint coords, matched to arrival hour. Batched in groups of 10 with 300ms delay to avoid rate limiting. |
| Elevation per segment | Open-Meteo elevation (80-point array) | Fetched once per route. Segment elevation diff interpolated from the array. |
| Road class per segment | Mapbox Directions steps (`steps=true`) | Extracted from `step.intersections[0].mapbox_streets_v8.class`. No extra API call. |
| Worst segment city name | Mapbox Reverse Geocoding | 1 call per route, only for the worst-scoring segment. |

---

### Rev2 Additions (Planned)

- **NHTSA crash index** — historical crash rate lookup by road segment, adds 10% weight as a calibration multiplier
- **Live traffic congestion** — Mapbox Traffic API (requires paid plan), enables snow + congestion compound multiplier (×1.25)
- **Vehicle type profiles** — car / truck / motorcycle weight adjustments (e.g. trucks more sensitive to grade and wind)

---

## Route Alerts Logic

| Condition | Trigger | Style |
|---|---|---|
| Rain | Any waypoint precip > 0.1mm | Amber left border |
| Strong wind | Any waypoint wind > 20mph | Amber left border |
| Freezing | Any waypoint temp < 35°F | Blue (#6399ff) left border |
| Low visibility | Any waypoint visibility < 3mi | Amber left border |
| All clear | No conditions triggered | Teal left border |

Each alert: emoji icon, bold title with time (e.g. "Rain at 2h 15m"), subtitle with city name (reverse geocoded) + driving advice, DM Mono meta line.

---

## Weather Emoji Mapping

| Code | Condition | Day | Night |
|---|---|---|---|
| 0 | Clear | ☀️ | 🌙 |
| 1–3 | Partly cloudy | ⛅ | 🌥️ |
| 45–48 | Fog | 🌫️ | 🌫️ |
| 51–65 | Rain | 🌧️ | 🌧️ |
| 71–77 | Snow | ❄️ | ❄️ |
| 80–82 | Showers | 🌦️ | 🌦️ |
| 95–99 | Thunderstorm | ⛈️ | ⛈️ |

Night = arrival hour before 6 or after 20.

---

## API Usage

### Mapbox Directions API
```
GET https://api.mapbox.com/directions/v5/mapbox/driving/{lng1},{lat1};{lng2},{lat2}
  ?alternatives=true&geometries=geojson&overview=full&steps=true
  &exclude=toll,motorway,ferry   (only when filters are active)
  &access_token={token}
```
`steps=true` is required — step objects expose `intersections[0].mapbox_streets_v8.class` which the risk engine uses for road class scoring.

### Mapbox Geocoding API (autocomplete)
```
GET https://api.mapbox.com/geocoding/v5/mapbox.places/{query}.json
  ?access_token={token}&autocomplete=true&limit=5&country=us,ca
```

### Mapbox Reverse Geocoding (alert city names)
```
GET https://api.mapbox.com/geocoding/v5/mapbox.places/{lng},{lat}.json
  ?types=place&access_token={token}
```

### Open-Meteo Weather (two separate grids)
```
GET https://api.open-meteo.com/v1/forecast
  ?latitude={lat}&longitude={lng}
  &hourly=temperature_2m,precipitation,wind_speed_10m,visibility,weather_code
  &wind_speed_unit=kmh&timezone=UTC&forecast_days=2
```
**Two separate fetch grids:**
- **45-min timeline waypoints** — power the Weather Timeline UI. Fetched via `sampleByTime()`, one per 45 minutes of travel.
- **Adaptive segment midpoints** — power the risk score engine. Fetched via `sampleRouteByDistance()`, one per 5/8/10-mile segment. Batched in groups of 10 with 300ms delay between batches to avoid rate limiting.

### Open-Meteo Elevation
```
GET https://api.open-meteo.com/v1/elevation
  ?latitude={lat1,...lat80}&longitude={lng1,...lng80}
```
80 evenly sampled points along route geometry. Returns meters.

---

## Deployment Workflow

```bash
# Develop locally
npm run dev                        # localhost:5173

# Test production build before pushing
npm run build && npm run preview   # localhost:4173

# Deploy to production
git add .
git commit -m "describe change"
git push                           # Vercel auto-deploys in ~60 seconds
```

Vercel is connected to `ddesai56/Pathcast` main branch. `VITE_MAPBOX_TOKEN` is set in Vercel dashboard environment variables.

---

## Known Issues / Bugs

1. **Elevation chart on Safari** — requires a click before hover events fire. Chrome works correctly. Needs further investigation.
2. **Mobile bottom sheet** — hard to collapse once fully expanded. Being addressed in mobile chat.
3. **Elevation on mobile** — chart interaction limited on small screens. Being addressed in mobile chat.
4. **Weather fetch intermittent errors** — could not be consistently reproduced. Open-Meteo occasionally rate-limits parallel requests. Monitor in production.

---

## Monetization Plan (Post-MVP)

**Free tier:**
- Unlimited route searches
- Basic risk score (number + label)
- Weather summary view
- Standard map view

**Pathcast Pro ($4.99/month or $39.99/year):**
- Full risk breakdown (all 5 factors)
- Full weather timeline (all 45-min waypoints)
- Departure time optimizer
- Saved routes
- EV mode (future)
- Ad-free experience

---

## Future — iOS App

Planned after web app is stable with real users. Native SwiftUI app built by a hired iOS developer, using the web app as the functional spec. Key additions: push notifications for route weather changes, offline mode.

**Navigation will NOT be built** — Pathcast hands off to Apple Maps / Google Maps / Waze via deep links. This is intentional.

---

*Keep this file up to date as the app evolves. It lives in the root of the GitHub repo so all Claude development chats can access it. Upload it at the start of every new chat session.*
