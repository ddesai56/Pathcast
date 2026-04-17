import { useMemo, useRef, useEffect } from 'react'
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  Filler,
  Tooltip,
} from 'chart.js'
import { Line } from 'react-chartjs-2'

ChartJS.register(CategoryScale, LinearScale, PointElement, LineElement, Filler, Tooltip)

// ── Gradient fill factory ─────────────────────────────────────
function makeGradient(context) {
  const { chart } = context
  const { ctx, chartArea } = chart
  if (!chartArea) return 'rgba(0,212,170,0.02)'
  const g = ctx.createLinearGradient(0, chartArea.top, 0, chartArea.bottom)
  g.addColorStop(0, 'rgba(0,212,170,0.25)')
  g.addColorStop(1, 'rgba(0,212,170,0.02)')
  return g
}

// ── Crosshair plugin (vertical hairline at hover position) ────
const crosshairPlugin = {
  id: 'pc-crosshair',
  afterDraw(chart) {
    const active = chart.tooltip?._active
    if (!active?.length) return
    const { ctx, chartArea: { top, bottom } } = chart
    const x = active[0].element.x
    ctx.save()
    ctx.beginPath()
    ctx.setLineDash([3, 3])
    ctx.moveTo(x, top)
    ctx.lineTo(x, bottom)
    ctx.lineWidth = 1
    ctx.strokeStyle = 'rgba(245,166,35,0.65)'
    ctx.stroke()
    ctx.restore()
  },
}

// ── Component ─────────────────────────────────────────────────
export default function ElevationChart({ elevFeet, distanceLabels, onHoverIdx }) {
  const chartRef   = useRef(null)
  // Keep callback in a ref so options memo never needs to list it as dep
  const hoverCbRef = useRef(onHoverIdx)
  useEffect(() => { hoverCbRef.current = onHoverIdx }, [onHoverIdx])

  // Remove hover marker when mouse leaves the canvas
  useEffect(() => {
    const canvas = chartRef.current?.canvas
    if (!canvas) return
    const onLeave = () => hoverCbRef.current?.(null)
    canvas.addEventListener('mouseleave', onLeave)
    return () => canvas.removeEventListener('mouseleave', onLeave)
  }, [])  // runs once after mount

  const data = useMemo(() => ({
    labels: distanceLabels,
    datasets: [{
      data:            elevFeet,
      borderColor:     '#00d4aa',
      borderWidth:     1.5,
      pointRadius:     0,
      tension:         0.4,
      fill:            true,
      backgroundColor: makeGradient,
    }],
  }), [elevFeet, distanceLabels])

  const options = useMemo(() => ({
    responsive:          true,
    maintainAspectRatio: false,
    animation:           false,
    interaction: {
      mode:       'index',
      intersect:  false,
    },
    onHover: (_, activeElements) => {
      const idx = activeElements[0]?.index ?? null
      hoverCbRef.current?.(idx)
    },
    plugins: {
      legend: { display: false },
      tooltip: {
        mode:            'index',
        intersect:       false,
        backgroundColor: '#1a1e28',
        borderColor:     'rgba(255,255,255,0.12)',
        borderWidth:     1,
        titleColor:      '#8b90a0',
        bodyColor:       '#f0f2f7',
        padding:         8,
        callbacks: {
          title: (items) => `${items[0].label} mi`,
          label: (ctx)   => `${Math.round(ctx.parsed.y).toLocaleString()} ft`,
        },
      },
    },
    scales: {
      x: {
        ticks: {
          color:       '#555b6e',
          font:        { size: 9, family: "'DM Mono', monospace" },
          maxRotation: 0,
          autoSkip:    false,
          callback: (_, idx) => {
            if (idx % 10 === 0 || idx === distanceLabels.length - 1) {
              return `${distanceLabels[idx]}mi`
            }
            return null
          },
        },
        grid:   { color: 'rgba(255,255,255,0.04)', drawTicks: false },
        border: { display: false },
      },
      y: {
        ticks: {
          color:         '#555b6e',
          font:          { size: 9, family: "'DM Mono', monospace" },
          maxTicksLimit: 5,
          callback: (val) => `${Math.round(val).toLocaleString()}ft`,
        },
        grid:   { color: 'rgba(255,255,255,0.04)', drawTicks: false },
        border: { display: false },
      },
    },
  }), [distanceLabels])

  return (
    <div style={{ width: '100%', height: '100%' }}>
      <Line
        ref={chartRef}
        data={data}
        options={options}
        plugins={[crosshairPlugin]}
      />
    </div>
  )
}
