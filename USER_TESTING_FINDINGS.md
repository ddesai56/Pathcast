# Pathcast — User Testing Findings

**Date:** April 19, 2026
**Scope:** Bugs, UX/UI issues, and performance concerns
**Site:** https://pathcast.vercel.app

> **Note on methodology:** The live site at `pathcast.vercel.app` could not be reached directly from the testing environment (network egress to that domain is blocked, and the browser automation extension was not connected). Findings below are based on a thorough review of the source code in this repository, which is the same code that is auto-deployed to the live URL via Vercel. Every finding is traceable to a specific file and line. Where a finding requires an actual runtime observation to confirm (e.g., a visual regression), it is marked as **[needs live verification]**.

---

## Priority legend

- 🔴 **P0 — Bug/showstopper** — breaks a core user flow or is a misleading claim about what the product does
- 🟠 **P1 — Important UX issue** — noticeably worsens the experience, likely to frustrate users
- 🟡 **P2 — Polish / smaller improvement** — quality-of-life improvement, not urgent
- 🔵 **P3 — Performance / tech debt** — code health or efficiency, no user-visible break

---

## Summary of top findings

1. 🔴 **"Open in Google Maps / Apple Maps / Waze" buttons are permanently disabled** — the hand-off to navigation is the final step of the journey, and it does nothing.
2. 🔴 **Missing features that the project doc claims are "complete":** unit toggle (mi/km), map style switcher (Streets / Satellite / Outdoors). Neither exists in the code.
3. 🔴 **No input validation** — user can click "Find Route" with coords for the same city as origin and destination, or other degenerate pairs, and the app will try to fetch routes/weather with no guard.
4. 🟠 **Autocomplete dropdown closes on outside click but not on Escape, Tab, or keyboard nav** — keyboard accessibility is missing.
5. 🟠 **Mapbox token is exposed client-side with no URL restriction visible in code** — if the Vercel token is not scoped, anyone viewing the source can exfiltrate it.
6. 🟠 **`handleSwap` calls `handleFindRoute()` but state updates are async** — swap + re-search reads stale coords on the ref it just overwrote, which can misorder A/B or skip re-fetch.
7. 🟠 **Toast always uses red styling**, even for neutral/info messages like "Weather data temporarily unavailable." Reads as an alarming error rather than a soft warning.
8. 🟠 **No loading feedback for geocoding autocomplete** — if Mapbox is slow, the input just looks dead.
9. 🟠 **Bottom sheet drag math is wrong when `half` pos is beyond `peek`** on short viewports — `h * 0.4` can exceed `h * 0.9 - 120` on small screens, inverting the snap order.
10. 🟡 **Departure time picker defaults to "now" and silently refetches the moment it's toggled on** — the toggle doubles as a fetch trigger, which is unexpected and wastes an API call.

Full detail below, grouped by area.

---

## 1. Functional bugs

### 🔴 1.1 "Open In" navigation hand-off buttons are non-functional

**Files:** `src/App.jsx` lines 1133 (mobile) and 1578 (desktop)

```jsx
{['Google Maps', 'Apple Maps', 'Waze'].map(app => (
  <Button key={app} variant="outline" size="sm" ... disabled>{app}</Button>
))}
```

Both the mobile and desktop "Open In" sections render three buttons with `disabled` hardcoded. There is no `onClick`, no deep-link URL construction, and no conditional enable logic based on whether a route exists. The project README lists "Navigate handoff — Open in buttons for Google Maps, Apple Maps, Waze" as a completed feature, but it is not wired up at all.

**Impact:** This is the final CTA of the entire flow — the user has picked the safer route and now wants to actually drive it. The buttons look tappable (they're sized at `minHeight: 44`, a touch target) but do nothing.

**Fix:** Construct deep links using the active route's origin and destination coords:
- Google Maps: `https://www.google.com/maps/dir/?api=1&origin=${olat},${olng}&destination=${dlat},${dlng}&travelmode=driving`
- Apple Maps: `https://maps.apple.com/?saddr=${olat},${olng}&daddr=${dlat},${dlng}&dirflg=d`
- Waze: `https://waze.com/ul?ll=${dlat},${dlng}&navigate=yes&from=${olat},${olng}`

Remove the `disabled` prop when `originCoords && destCoords && routes.length > 0`.

### 🔴 1.2 Missing: unit toggle (mi/km)

**File:** `src/App.jsx` and `src/utils/format.js` — grep-wide confirms no toggle state exists.

The project doc lists this under "Complete and working": *"Unit toggle — mi/ft ↔ km/m throughout the app."* But:
- `format.js` hardcodes `miles = meters / 1609.344` and returns `"X.X mi"` with no unit parameter.
- `formatDistance` takes only `meters`, not a units preference.
- `processElevation` hardcodes `fmtFt = (m) => "X ft"`.
- All temperatures render as `${pt.tempF}°F`, winds as `${pt.windMph} mph`, etc.
- No toggle UI, no `useUnits` state, no context.

**Impact:** Non-US/Canada users (and metric-preferring users in those countries) get no option. The app is US/Canada-scoped by geocoder (`country=us,ca`), but still excludes Canadians who prefer metric.

**Fix:** Add a `units` state (`'imperial' | 'metric'`), a persistence layer (`localStorage`), a small toggle in the header/sidebar, and have all formatters accept a units arg.

### 🔴 1.3 Missing: map style switcher

**File:** `src/components/MapView.jsx`

The Mapbox map is hardcoded to `'mapbox://styles/mapbox/dark-v11'`. The project doc lists "Map style switcher — Streets, Satellite, Outdoors" as complete. There is no `setStyle` call, no switcher UI, no style state anywhere in the source.

**Fix:** Add a small control (e.g., a bottom-left chip or icon menu) that calls `map.setStyle('mapbox://styles/mapbox/streets-v12' | 'satellite-streets-v12' | 'outdoors-v12')`. Be aware that `setStyle` wipes custom layers and sources — the existing routes and weather markers will need to be re-added on the `style.load` event.

### 🔴 1.4 `handleSwap` has a race condition that can read stale coords

**File:** `src/App.jsx` lines 712–723

```jsx
function handleSwap() {
  const tmpText   = originText
  const tmpCoords = originCoordsRef.current
  setOriginText(destText)
  setDestText(tmpText)
  setOriginCoords(destCoordsRef.current)
  setDestCoords(tmpCoords)
  originCoordsRef.current = destCoordsRef.current   // <-- reads the ref we're about to overwrite
  destCoordsRef.current   = tmpCoords
  if (routesRef.current.length > 0) handleFindRoute()
}
```

Two issues:

1. The line `originCoordsRef.current = destCoordsRef.current` assigns destCoords to originCoords, then the next line `destCoordsRef.current = tmpCoords` writes what was *originally* origin into dest. That's correct *only because* `tmpCoords` snapshotted before the mutation. This is subtle and fragile — any reorder breaks it.
2. More importantly, after the swap, `handleFindRoute()` is called synchronously — but `handleFindRoute` also calls `setLoading(true)` and `setRoutes([])` which schedule re-renders. The map marker setup in `handleFindRoute` uses `originCoordsRef.current` / `destCoordsRef.current` which are updated (good), but `loadAllConditions` passes `useScheduled ? new Date(departureTime) : new Date()` — if `useScheduled` was just toggled off between user intent and event handler, the wrong date may be used.

**Fix:** Use snapshots for both refs and wrap the coord update in `queueMicrotask` or pass the new coords explicitly to `handleFindRoute(newOrigin, newDest)` as parameters so there is no implicit dependence on ref mutation order.

### 🔴 1.5 No guard against origin === destination

**File:** `src/App.jsx` line 547 (`handleFindRoute`)

```jsx
async function handleFindRoute() {
  const org = originCoordsRef.current
  const dst = destCoordsRef.current
  if (!org || !dst) return
  ...
}
```

If the user picks the same address twice (or two addresses within a few meters of each other — e.g., "Starbucks" selected twice in a city), the app still calls Mapbox Directions, which may return a degenerate route with `duration` near 0 and `coordinates.length === 2`. Downstream:
- `sampleByTime` will push only the start and end point (both same). Weather fetch still fires.
- `processElevation` with 2 same-point samples returns 0 gain — probably fine.
- Risk score calculation likely returns `total: 0` but `alerts` will show a misleading "All clear" banner with no real data.

**Fix:** Before calling Directions, compute `haversine(org, dst)` and short-circuit if < 500m with a toast like *"Origin and destination are the same location."*

### 🟠 1.6 "Find Route" does not re-fetch if only the *text* changed, only if a new suggestion was selected

**File:** `src/components/AutocompleteInput.jsx` lines 31–38

```jsx
function handleChange(e) {
  const val = e.target.value
  onChange(val)
  onClearCoords?.()    // <-- wipes coords on every keystroke
  search(val)
  setOpen(true)
  ...
}
```

Every keystroke calls `onClearCoords()`, which means the user must re-select a suggestion from the dropdown. If they type, then click away accidentally (dropdown closes), the text is still there but `originCoords` is `null` — and "Find Route" silently becomes disabled with no feedback about why.

**Impact:** Users think their address is "entered" because they can see the text, but the button is greyed out. There's no hint that they need to click a dropdown item.

**Fix:** Add a subtle hint in the input when text is present but coords are missing: a small "Pick a suggestion" or a coloured underline. Better: if exactly one suggestion remains when the user tabs/blurs, auto-select it.

### 🟠 1.7 Bottom-sheet drag snap positions can invert on short viewports

**File:** `src/App.jsx` lines 52–57

```jsx
function getSnapPx(pos) {
  const h = window.innerHeight
  if (pos === 'full') return 0
  if (pos === 'half') return Math.round(h * 0.4)
  return Math.round(h * 0.9 - 120)  // peek
}
```

On viewports where `h * 0.9 - 120 < h * 0.4`, i.e. `h < ~600px`, the "peek" position is *above* the "half" position. That is: on very short phones (iPhone SE 1st gen is 568px tall, some landscape orientations are ~390px), dragging *down* would snap up, and the "peek" and "half" order is inverted. The snapping logic in `handleSheetTouchEnd` assumes `full < half < peek` in px translate space.

**Fix:** Clamp so `peek >= half >= full + minGap`, e.g. `half = Math.min(h * 0.4, h * 0.9 - 240)`.

### 🟠 1.8 Weather fetch clamps arrival time to "last available slot" silently on long trips

**File:** `src/utils/weatherElevation.js` lines 141–146

```jsx
let idx = times.indexOf(targetHour)
if (idx === -1) idx = times.length - 1   // clamp to last slot
```

`forecast_days=2` means 48 hours of forecast. A long overnight road trip departing at, say, 8 PM and lasting 12 hours falls within 2 days — fine. But a 36+ hour itinerary or a departure time set more than 24h in the future will quietly use the wrong (clamped) hour, and the user sees weather that *looks* valid but isn't. No warning, no indicator.

**Fix:** If `idx === -1`, either (a) show a per-waypoint `stale` flag that renders as a greyed-out card with "beyond forecast range", or (b) bump `forecast_days` to the max allowed and still gate behaviour explicitly rather than clamping.

### 🟠 1.9 `sampleByTime` can produce zero intermediate waypoints for short trips

**File:** `src/utils/weatherElevation.js` lines 49–65

```jsx
for (let t = INTERVAL; t < durationSeconds - 60; t += INTERVAL) { ... }
```

For a trip shorter than 45 min (`INTERVAL = 2700s`), the loop body never executes, so `timePoints` has only `[start, end]`. Then:
- `sampleMarkersToShow(weatherPoints, 8)` returns 2 markers.
- Risk score has 2 data points — statistically weak.
- Alerts logic (in `App.jsx` `generateAlerts`) iterates only 2 points — fine functionally but misleading for a 40-minute drive through a storm.

**Fix:** Use a smaller interval when `durationSeconds < 3600`, e.g. 15-minute samples for trips under an hour.

### 🟠 1.10 Route markers are created twice and pushed to the same array

**File:** `src/App.jsx` — `handleFindRoute` (line 583) and `handleRouteSelect` (line 612) both add A/B markers. `drawRoutesOnMap` at the top of each handler calls `markers.forEach(m => m.remove()); markers.length = 0` — so the removal happens first — **but** `handleRouteSelect` only clears via `drawRoutesOnMap`, then re-adds A/B even though the markers were already on-screen before clearing. Cosmetically fine, but it causes a brief "blink" of the A/B endpoint markers every time you switch routes.

**Fix:** Lift A/B marker placement to its own effect keyed on `[originCoords, destCoords]` and let it be independent of the route-line redraw.

### 🟡 1.11 Autocomplete dropdown filters on `country=us,ca` but the placeholder text says "Enter starting location"

**File:** `src/hooks/useGeocoding.js` line 17

There's no UI indication that only US and Canada addresses will autocomplete. A user searching "Rome" will get *very* few or zero results and no explanation.

**Fix:** Update placeholder to `"City or address (US / Canada)"` or show a one-time info tooltip.

### 🟡 1.12 `fetchCityName` does reverse geocoding once per waypoint — a 12-hour route can spawn 16+ parallel requests

**File:** `src/App.jsx` line 97 and `loadAllConditions` line 502

```jsx
const allCityNames = await Promise.all(
  allWeatherPoints.map(pts =>
    Promise.all(pts.map(pt => fetchCityName(pt.coords[0], pt.coords[1])))
  )
)
```

For two routes, each with up to `duration / 2700` waypoints, this fires ~16–40 Mapbox reverse-geocoding requests per Find Route. Mapbox charges per request.

**Fix:** Only reverse-geocode the 1–3 waypoints that actually produce alerts (i.e., run `generateAlerts` first with a placeholder city, then reverse-geocode just those points lazily).

---

## 2. UX / UI issues

### 🟠 2.1 Toast is always red — even for non-error messages

**File:** `src/components/Toast.jsx` line 18, `src/App.jsx` line 539 + 593

```jsx
background: '#ff4757',   // riskHigh
```

The only toast variant is an aggressive red error banner. But the code uses it for soft failures like `'Weather data temporarily unavailable'`, which is not a critical error — the routes still display.

**Fix:** Add a `variant` prop (`'error' | 'info' | 'warning'`). Use amber or neutral for partial-data warnings; reserve red for true failures.

### 🟠 2.2 Loading states are inconsistent between sections

- **Route alerts:** says "Analyzing weather data…" (App.jsx line 1428)
- **Weather timeline:** says "Fetching weather data…" (line 1566)
- **Elevation panel:** says "Loading elevation data…" (line 1642)
- **Find Route button:** says "Analyzing route..." (desktop, line 1238) and "Analyzing route…" (mobile, line 872) — one uses three dots, the other uses an ellipsis character.

**Fix:** Pick one phrasing + one ellipsis style and stick with it. Suggest just "Analyzing…" or a consistent skeleton loader.

### 🟠 2.3 Risk score panel shows `--` on the big number when no route is loaded, but the factor bars still render as a full 0% list with labels

**File:** `src/App.jsx` lines 1400–1414

Even with no active route, the sidebar shows five faded factor bars ("Precipitation 0", "Elevation 0", …). This is visually noisy for a blank-slate state.

**Fix:** Only render the breakdown bars when `riskScore` is defined. In the empty state, show one brief line: "Enter a route to see your risk breakdown."

### 🟠 2.4 "Best" badge can disagree with the active route indicator

**File:** `src/App.jsx` line 944 (mobile) and 1297 (desktop)

If Route A is active (accent highlight) but Route B has a lower risk score, Route B gets the "Best" chip. That's correct, but visually confusing: user sees a "Best" label next to the *inactive* card. The tradeoff text tries to explain ("Route B is 12 points safer…"), but a user may miss it.

**Fix:** When the user is viewing a non-best route, show a small inline CTA on the Best card: `"Switch to Route B →"` that calls `handleRouteSelect(1)` on click.

### 🟠 2.5 The entire `SectionLabel` row is styled as a micro-label, but section order and spacing is identical for every section — no visual hierarchy between "Risk Score" (the headline metric) and "Weather Timeline" (supporting detail)

**File:** `src/App.jsx` — all sections use the same `SectionLabel` typography (10px, 0.1em letter-spacing, uppercase). Risk Score is the centerpiece of the app, yet it receives no typographic promotion.

**Fix:** Either scale up the Risk Score big-number to dominate, or give it a subtle background card to read as the "hero" metric.

### 🟠 2.6 Weather popup on hover has no accessibility/keyboard path

**File:** `src/App.jsx` lines 392–393

```jsx
el.addEventListener('mouseenter', () => popup.addTo(map))
el.addEventListener('mouseleave', () => popup.remove())
```

Mouse-only. Keyboard users (tab nav) and touch users can't see the weather detail popup. On mobile, the pill marker doesn't respond to taps at all — the popup only appears on `mouseenter`.

**Fix:** Also bind `click` / `touchstart` to toggle, and give the pill a `role="button"` + `tabindex="0"` + `aria-label`.

### 🟠 2.7 Datetime picker has no max limit and no "reset to now"

**File:** `src/App.jsx` line 1273

```jsx
<input type="datetime-local" value={departureTime} ... />
```

A user can select a departure 3 weeks out — but Open-Meteo forecasts max 16 days (and we're fetching only 2 days). There's no `max` attribute and no feedback when a date is out of range. The weather will silently clamp (see bug 1.8).

**Fix:** Set `max={toDatetimeLocal(new Date(Date.now() + 2 * 24 * 3600 * 1000))}`. Show a helper text: "Forecast available up to 2 days out."

### 🟠 2.8 Autocomplete has no keyboard navigation

**File:** `src/components/AutocompleteInput.jsx`

There is a `hoveredIdx` state but it's only updated by `onMouseEnter` / `onMouseLeave`. No `onKeyDown` handler for ↑ / ↓ / Enter / Escape. Pressing Enter in the input does nothing; Tab blurs the input and closes the dropdown (via the outside-click handler on `mousedown`) — so Tab to the "Find Route" button is fine, but the user can't pick a suggestion without a mouse.

**Fix:** Add key handling: Arrow Up/Down moves `hoveredIdx`, Enter selects `suggestions[hoveredIdx]`, Escape closes.

### 🟠 2.9 The swap button title and icon are inconsistent in style between mobile and desktop

**Desktop (line 1204):** `title="Swap origin and destination"` — full sentence.
**Mobile (line 856):** `title="Swap"` — one word.

Minor, but inconsistent.

### 🟡 2.10 Mobile top bar chevron rotation logic is inverted from mental model

**File:** `src/App.jsx` line 821

```jsx
<ChevronDown ... transform: topBarCollapsed ? 'rotate(0deg)' : 'rotate(180deg)' />
```

When expanded (`!topBarCollapsed`), the chevron points *up* (rotated 180°). When collapsed, it points *down*. The common convention is: chevron points *toward* the hidden content — so collapsed (content hidden above? below?) should be disambiguated. Because the inputs expand *downward* below the chevron, a collapsed state with a downward-pointing chevron reads as "click to reveal content below" — which matches. But when expanded, upward arrow reads as "click to hide content up" — slightly awkward if the user thinks of the bar as static.

Minor issue; only worth flagging because it's inconsistent with how most apps handle this.

### 🟡 2.11 "Find Route" button disabled state gives no hint why

**File:** `src/App.jsx` line 866 + 1234

`disabled={!canSearch || loading}` where `canSearch = !!(originCoords && destCoords)`. If either is null, the button is silently greyed out. The user may have typed two addresses but not selected suggestions — the button is greyed with no explanation.

**Fix:** When disabled because of missing coords, show a tooltip on hover: `"Pick a suggested address for both inputs."` Or, even simpler: show a small inline error below the input that lost its coords.

### 🟡 2.12 No empty-state illustration on mobile

**File:** Desktop (line 1594–1605) has a nice `<Navigation>` icon + text when no routes. Mobile shows the map full-bleed plus only "Search for a route to begin" in the peek sheet. No hero imagery or cue that the inputs above are the starting point.

**Fix:** Show a translucent "Enter a start and destination" overlay at the center of the map on mobile until the first route is loaded.

### 🟡 2.13 Route card shows "— · —" placeholder distance when no route loaded, but the mobile card shows "— · —" (two dashes) and desktop shows "— · — · —" (three). Small inconsistency.

Files: `App.jsx` line 981 vs line 1359.

### 🟡 2.14 `toUTCHourStr` uses UTC to index into the `timezone=UTC` forecast — this is correct — but the *user* sees times in their local timezone via `formatClockTime`. There is no timezone indicator in the weather cards.

If a user is planning a drive from Vancouver (UTC-7) at 9 PM local and the cards show "9:45 PM", "10:30 PM"…, that's good. But if they schedule something in a different timezone (e.g., via remote desktop), the mismatch will be confusing. Add a small timezone label once, somewhere visible.

---

## 3. Accessibility

### 🟠 3.1 No `<main>`, `<nav>` landmarks on mobile; on desktop the sidebar is `<aside>` and right column is `<main>` (good) but none have `aria-label`

**File:** `src/App.jsx` line 1170 (`<aside>`) and 1589 (`<main>`)

### 🟠 3.2 Color-only signalling of risk

The risk score uses only color (`#00d4aa`, `#f5a623`, `#ff4757`) and a numeric label. Colorblind users may not distinguish amber from red easily. There's a text label ("Low risk" / "Moderate risk") which helps — but the route-comparison card's thin colored bar has no text.

**Fix:** Add an icon (shield / warning triangle / cross) next to the numeric score.

### 🟠 3.3 No `lang="en"` on dynamic content, no `aria-live` region for the toast

**File:** `src/components/Toast.jsx`

The toast is important feedback — it should be in an `aria-live="polite"` region so screen readers announce it.

**Fix:** Add `role="status" aria-live="polite"` to the toast div.

### 🟡 3.4 Focus outlines are suppressed in `index.css` line 49

```css
.pc-input:focus { outline: none; box-shadow: none; border: 1px solid #00d4aa; }
```

The teal border works as a visible focus state, which is good — but the button `focus-visible:outline-none` in `src/components/ui/button.jsx` line 7 removes outline without a replacement. Keyboard users lose focus visibility on buttons.

**Fix:** Add `focus-visible:ring-2 focus-visible:ring-[#00d4aa]` to the button variants.

### 🟡 3.5 Inputs don't have associated `<label>` elements — placeholder does double duty

Placeholders are not a substitute for labels. Add a visually-hidden `<label>` per input: `<label className="sr-only">Starting location</label>`.

---

## 4. Performance

### 🔵 4.1 App.jsx is a 1,654-line file with dozens of inline style objects

Every render recreates all the style objects, adding GC pressure. The file has both mobile and desktop rendering inline. Split into `<MobileShell />` and `<DesktopShell />` components in separate files, hoist styles to `const` objects outside the component, or move to CSS modules / Tailwind.

### 🔵 4.2 `fetchCityName` is not debounced or cached

Same coord can be looked up multiple times across route switches. A simple `Map` cache keyed on `lng,lat` (rounded to 3 decimals) would eliminate duplicate reverse-geocode calls when switching routes.

### 🔵 4.3 Elevation API receives 80 comma-separated lat/lng pairs in the URL

**File:** `src/utils/weatherElevation.js` line 73

URL length is ~2,000 characters for an 80-point query. Open-Meteo accepts this today but URL-length limits vary by proxy/CDN. Consider POST or splitting into batches if you ever hit 414 errors.

### 🔵 4.4 `generateAlerts` runs O(n) per route per render

`alerts[activeRouteIdx]` is precomputed at fetch time and stored in `allAlerts`, so the per-render cost is just a lookup. That's fine. But the trade-off-text block in the Route Comparison section is recomputed on *every* render. Memoize it with `useMemo` keyed on `[allRiskScores, routes]`.

### 🔵 4.5 `useLayoutEffect` with empty dep array for the bottom-sheet init is fine on mobile, but the effect runs on *every* mount including desktop. It's guarded by `if (!sheetRef.current) return` but the mobile check happens *inside* the mobile branch, so the ref is never attached on desktop. The effect body then no-ops — fine. But cleaner to only install the effect inside the mobile render tree.

### 🔵 4.6 Mapbox token is accessed as `import.meta.env.VITE_MAPBOX_TOKEN` — make sure it is URL-restricted in the Mapbox dashboard

Vite exposes `VITE_*` env vars to the client bundle by design. Anyone inspecting the site can extract your token. This is not a bug (it's how Mapbox public tokens work), but the dashboard should restrict the token to `pathcast.vercel.app` and `localhost:5173` so stolen tokens can't be abused on other domains. No way to verify from code — marked as **[needs live verification]** of the Mapbox dashboard settings.

---

## 5. Small polish items

### 🟡 5.1 Hardcoded ellipses: "Analyzing route…" vs "Analyzing route..." — pick one (prefer the Unicode `…`).

### 🟡 5.2 `formatDistance` always shows 1 decimal. For very short trips this is fine; for long ones, "425.7 mi" has the same decimal precision as "12.3 mi". Consider 0 decimals when miles > 100.

### 🟡 5.3 `Toast` uses `whiteSpace: 'nowrap'` — a long error message will overflow the viewport on mobile. Allow wrapping on narrow screens.

### 🟡 5.4 `public/` has default Vite `favicon.svg` and `vite.svg` still referenced in `src/assets`. Confirm the favicon is the Pathcast brand icon, not the default Vite one. **[needs live verification]**

### 🟡 5.5 `App.css` still contains the default Vite template CSS (`.counter`, `.hero`, `#center`, `#next-steps`, `#docs`) that is unused by the actual app. Delete it.

### 🟡 5.6 Route A/B labels are fine, but "A" and "B" in a route-comparison context could benefit from a subtitle like "Fastest" / "Safer" / "Scenic" once the engine has more data. Currently only "Best" is annotated.

### 🟡 5.7 Weather emoji fallback: the `WEATHER_CODES` map misses code 2 (it maps to "Partly cloudy" — ok) and code 66, 67 (freezing rain), 85, 86 (snow showers). Unknown codes fall back to "Clear ☀️" which is dangerous — showing a sunshine icon for freezing rain is misleading. Add those codes, and change the fallback to "Unknown ❓" not "Clear".

### 🟡 5.8 README.md still has the default Vite template content ("React + Vite", "React Compiler"). Update to describe Pathcast.

---

## 6. Security / correctness

### 🟠 6.1 Mapbox token passed in query string — visible in server/proxy logs

**Files:** `src/App.jsx` line 101, `src/hooks/useGeocoding.js` line 17, `src/App.jsx` line 567.

Mapbox *requires* tokens in the URL for browser-side usage; there's no avoiding it here. Just re-flagging: restrict the token to your domain (see 4.6).

### 🟠 6.2 Open-Meteo URLs don't have an API key (correct — they don't need one), but the app has no rate-limit backoff. Open-Meteo's free tier is 10,000 req/day. With aggressive use (swap + re-fetch + route switch + schedule change) each route gets N+1 fetches. Add retry-with-exponential-backoff and a circuit breaker.

### 🟠 6.3 `try { ... } catch { setToast('Weather data temporarily unavailable') }` in `loadAllConditions` (line 538)

Swallows all errors, including programming mistakes (e.g., `TypeError` in `processElevation`). The user sees "Weather data temporarily unavailable" when the real cause might be an elevation-processing bug. Log the error to the console at minimum; even better, report to a telemetry endpoint.

```jsx
} catch (err) {
  console.error('Conditions load failed:', err)
  setToast('Weather data temporarily unavailable')
}
```

### 🟡 6.4 No CSP meta tag in `index.html`. Not a bug, but adding a basic `Content-Security-Policy` for `connect-src` restricting to `api.mapbox.com` and `api.open-meteo.com` would harden the app against XSS exfiltration.

---

## 7. Things that *look* right (worth preserving)

Not everything is broken — a few things are well done and shouldn't be undone in a refactor:

- **Parallel data fetching.** `loadAllConditions` fetches weather for both routes in parallel, then elevation for both in parallel. Good — means Route B is scored immediately when the user switches.
- **Design tokens centralized.** The `C` object at the top of `App.jsx` makes palette changes trivial.
- **Interpolated risk scoring.** Breakpoint-based `interpolateScore` is much better than hard thresholds; it gives smoothly-changing scores as conditions change.
- **`sampleByTime` is smart.** Sampling weather points every 45 minutes of *drive time* (not distance) is the right model — a traffic-heavy 10-mile stretch gets the same attention as an open-highway 50-mile stretch.
- **Mobile bottom sheet snapping with velocity.** Real velocity math in `handleSheetTouchEnd`. Good touch feel.
- **Elevation ↔ map sync.** The pulsing amber marker moving as you hover the chart is a nice touch.

---

## 8. Recommended priority order for fixes

A concrete week's worth of work in rough order:

1. **Wire up "Open In" buttons** (1.1) — 30 minutes. Biggest user-visible gap.
2. **Add origin === destination guard** (1.5) — 15 minutes.
3. **Fix `handleSwap` race** (1.4) — 30 minutes.
4. **Add keyboard navigation to autocomplete** (2.8) — 1 hour. Big accessibility win.
5. **Rename "Weather data unavailable" toast to non-red variant, add `variant`** (2.1, 3.3) — 1 hour.
6. **Map style switcher** (1.3) — 2 hours, plus handling custom-layer reattach on `style.load`.
7. **Unit toggle** (1.2) — half a day. Thread units through all formatters.
8. **Bottom-sheet snap clamp** (1.7) — 15 minutes.
9. **Autocomplete "pick a suggestion" hint** (1.6) — 30 minutes.
10. **Datetime `max` attribute + helper text** (2.7) — 15 minutes.

Everything in the P2 / P3 tier can be batched into a polish/refactor sprint.

---

*End of findings.*
