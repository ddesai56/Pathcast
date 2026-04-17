import { useEffect } from 'react'

export default function Toast({ message, onDismiss }) {
  useEffect(() => {
    if (!message) return
    const t = setTimeout(onDismiss, 3000)
    return () => clearTimeout(t)
  }, [message, onDismiss])

  if (!message) return null

  return (
    <div style={{
      position: 'fixed',
      bottom: 28,
      left: '50%',
      transform: 'translateX(-50%)',
      background: '#ff4757',
      color: '#fff',
      padding: '10px 20px',
      borderRadius: 8,
      fontSize: 13,
      fontWeight: 500,
      zIndex: 9999,
      boxShadow: '0 4px 20px rgba(255,71,87,0.45)',
      whiteSpace: 'nowrap',
      pointerEvents: 'none',
    }}>
      {message}
    </div>
  )
}
