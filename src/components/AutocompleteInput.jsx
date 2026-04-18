import { useState, useRef, useEffect } from 'react'
import { Input } from '@/components/ui/input'
import { useGeocoding } from '@/hooks/useGeocoding'

export default function AutocompleteInput({
  placeholder,
  value,
  onChange,
  onSelect,
  onClearCoords,
  iconEl,
  inputStyle,   // optional extra styles forwarded to the <Input>
}) {
  const [open, setOpen] = useState(false)
  const [hoveredIdx, setHoveredIdx] = useState(-1)
  const { suggestions, search, clear } = useGeocoding()
  const containerRef = useRef(null)

  // Close dropdown on outside click
  useEffect(() => {
    function handler(e) {
      if (containerRef.current && !containerRef.current.contains(e.target)) {
        setOpen(false)
        clear()
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [clear])

  function handleChange(e) {
    const val = e.target.value
    onChange(val)
    onClearCoords?.()
    search(val)
    setOpen(true)
    setHoveredIdx(-1)
  }

  function handleSelect(feature) {
    onChange(feature.place_name)
    onSelect(feature.geometry.coordinates) // [lng, lat]
    setOpen(false)
    clear()
  }

  return (
    <div ref={containerRef} style={{ position: 'relative' }}>
      {iconEl}
      <Input
        style={{ paddingLeft: 36, ...inputStyle }}
        placeholder={placeholder}
        value={value}
        onChange={handleChange}
        onFocus={() => { if (suggestions.length > 0) setOpen(true) }}
        autoComplete="off"
        spellCheck={false}
      />

      {open && suggestions.length > 0 && (
        <div style={{
          position: 'absolute',
          top: 'calc(100% + 4px)',
          left: 0,
          right: 0,
          zIndex: 1000,
          background: '#1a1e28',
          border: '1px solid rgba(255,255,255,0.12)',
          borderRadius: 8,
          overflow: 'hidden',
          boxShadow: '0 8px 32px rgba(0,0,0,0.6)',
        }}>
          {suggestions.map((feature, idx) => (
            <div
              key={feature.id}
              onPointerDown={() => handleSelect(feature)}
              onMouseEnter={() => setHoveredIdx(idx)}
              onMouseLeave={() => setHoveredIdx(-1)}
              style={{
                padding: '9px 12px',
                fontSize: 13,
                color: '#f0f2f7',
                cursor: 'pointer',
                background: hoveredIdx === idx ? '#222736' : 'transparent',
                borderBottom: idx < suggestions.length - 1 ? '1px solid rgba(255,255,255,0.05)' : 'none',
                transition: 'background 0.1s',
                lineHeight: 1.4,
              }}
            >
              <div style={{ fontWeight: 500 }}>{feature.text}</div>
              <div style={{ fontSize: 11, color: '#555b6e', marginTop: 1 }}>
                {feature.place_name.split(`${feature.text}, `)[1] || feature.place_name}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
