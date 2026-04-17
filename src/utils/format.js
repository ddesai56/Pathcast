export function formatDuration(seconds) {
  const h = Math.floor(seconds / 3600)
  const m = Math.round((seconds % 3600) / 60)
  if (h === 0) return `${m}m`
  return `${h}h ${m}m`
}

export function formatDistance(meters) {
  const miles = meters / 1609.344
  return `${miles.toFixed(1)} mi`
}
