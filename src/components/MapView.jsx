import { useEffect, useRef } from 'react'
import mapboxgl from 'mapbox-gl'

// Token is set by App.jsx before this component mounts
export default function MapView({ onMapReady }) {
  const containerRef = useRef(null)

  useEffect(() => {
    const map = new mapboxgl.Map({
      container: containerRef.current,
      style: 'mapbox://styles/mapbox/dark-v11',
      center: [-95, 38],
      zoom: 3.5,
    })

    map.addControl(new mapboxgl.NavigationControl(), 'bottom-right')
    map.on('load', () => onMapReady?.(map))

    return () => map.remove()
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  return <div ref={containerRef} style={{ width: '100%', height: '100%' }} />
}
