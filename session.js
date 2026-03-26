const store = new Map()
const TTL_MS = 10 * 60 * 1000

export function getSession(userId) {
  const s = store.get(userId)
  if (!s) return null
  if (Date.now() - s.createdAt > TTL_MS) { store.delete(userId); return null }
  return s
}
export function setSession(userId, data) {
  store.set(userId, { ...data, createdAt: Date.now() })
}
export function clearSession(userId) {
  store.delete(userId)
}

setInterval(() => {
  const now = Date.now()
  for (const [k, v] of store.entries()) {
    if (now - v.createdAt > TTL_MS) store.delete(k)
  }
}, 5 * 60 * 1000)
