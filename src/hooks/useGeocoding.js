import { useState, useRef, useCallback } from 'react'

const TOKEN = import.meta.env.VITE_MAPBOX_TOKEN

export function useGeocoding() {
  const [suggestions, setSuggestions] = useState([])
  const timerRef = useRef(null)

  const search = useCallback((query) => {
    clearTimeout(timerRef.current)
    if (!query || query.length < 2) {
      setSuggestions([])
      return
    }
    timerRef.current = setTimeout(async () => {
      try {
        const url = `https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(query)}.json?access_token=${TOKEN}&autocomplete=true&limit=5&country=us,ca`
        const res = await fetch(url)
        const data = await res.json()
        setSuggestions(data.features || [])
      } catch {
        setSuggestions([])
      }
    }, 300)
  }, [])

  const clear = useCallback(() => {
    clearTimeout(timerRef.current)
    setSuggestions([])
  }, [])

  return { suggestions, search, clear }
}
