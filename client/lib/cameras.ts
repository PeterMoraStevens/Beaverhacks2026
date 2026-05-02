import type { Camera } from '@/app/api/cameras/route'

const STORAGE_KEY = 'surveillance_cameras'

export interface StoredCamera extends Camera {
  queriedAt: string
  queryLat: number
  queryLon: number
}

export async function fetchCamerasForPoint(
  lat: number,
  lon: number,
  radius = 100
): Promise<StoredCamera[]> {
  const res = await fetch(
    `/api/cameras?lat=${lat}&lon=${lon}&radius=${radius}`
  )

  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error(err.error ?? `Camera fetch failed (${res.status})`)
  }

  const { cameras }: { cameras: Camera[] } = await res.json()

  const stamped: StoredCamera[] = cameras.map((c) => ({
    ...c,
    queriedAt: new Date().toISOString(),
    queryLat: lat,
    queryLon: lon,
  }))

  mergeCamerasToStorage(stamped)

  return stamped
}

export async function fetchCamerasForPath(
  points: { lat: number; lon: number }[],
  radius = 100
): Promise<StoredCamera[]> {
  const results = await Promise.all(
    points.map((p) => fetchCamerasForPoint(p.lat, p.lon, radius))
  )

  // Deduplicate by camera id — the final storage write already handles this,
  // but we return a clean list to the caller too.
  const seen = new Set<number>()
  return results.flat().filter((c) => {
    if (seen.has(c.id)) return false
    seen.add(c.id)
    return true
  })
}

function mergeCamerasToStorage(incoming: StoredCamera[]): void {
  if (typeof window === 'undefined') return

  const existing = getCamerasFromStorage()
  const byId = new Map(existing.map((c) => [c.id, c]))

  for (const c of incoming) {
    byId.set(c.id, c)
  }

  localStorage.setItem(STORAGE_KEY, JSON.stringify([...byId.values()]))
}

export function getCamerasFromStorage(): StoredCamera[] {
  if (typeof window === 'undefined') return []

  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    return JSON.parse(raw) as StoredCamera[]
  } catch {
    return []
  }
}

export function clearCamerasFromStorage(): void {
  if (typeof window === 'undefined') return
  localStorage.removeItem(STORAGE_KEY)
}
