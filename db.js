/**
 * db.js — SQLite-backed user store
 *
 * Table: users
 *   userId          TEXT PRIMARY KEY   (LINE user ID)
 *   accessToken     TEXT               (Google OAuth access token)
 *   refreshToken    TEXT               (Google OAuth refresh token)
 *   tokenExpiry     INTEGER            (unix ms)
 *   driveFolder     TEXT               (Drive folder ID chosen by user)
 *   driveFolderName TEXT               (human-readable name for display)
 *   sheetId         TEXT               (Spreadsheet ID chosen by user)
 *   sheetName       TEXT               (Tab name, default '發票記錄')
 *   setupDone       INTEGER            (0 or 1)
 *   createdAt       INTEGER
 *   updatedAt       INTEGER
 *
 * Table: oauth_states
 *   state      TEXT PRIMARY KEY   (random CSRF token)
 *   userId     TEXT               (LINE userId)
 *   expiresAt  INTEGER
 */

import Database from 'better-sqlite3'
import { createHmac, randomBytes, timingSafeEqual } from 'crypto'
import path from 'path'

const DB_PATH = process.env.DB_PATH || path.join(process.cwd(), 'data.db')
const db = new Database(DB_PATH)
db.pragma('journal_mode = WAL')

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    userId          TEXT PRIMARY KEY,
    accessToken     TEXT,
    refreshToken    TEXT,
    tokenExpiry     INTEGER,
    driveFolder     TEXT,
    driveFolderName TEXT,
    sheetId         TEXT,
    sheetName       TEXT DEFAULT '發票記錄',
    setupDone       INTEGER DEFAULT 0,
    createdAt       INTEGER NOT NULL,
    updatedAt       INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS oauth_states (
    state     TEXT PRIMARY KEY,
    userId    TEXT NOT NULL,
    expiresAt INTEGER NOT NULL
  );
`)

// ── Users ──────────────────────────────────────────────────────────────────

export function getUser(userId) {
  return db.prepare('SELECT * FROM users WHERE userId = ?').get(userId) ?? null
}

export function upsertUser(userId, fields) {
  const now = Date.now()
  const existing = getUser(userId)
  if (!existing) {
    const cols = ['userId', 'createdAt', 'updatedAt', ...Object.keys(fields)]
    const vals = ['userId', 'createdAt', 'updatedAt', ...Object.keys(fields).map((k) => '@' + k)]
    db.prepare(`INSERT INTO users (${cols.join(',')}) VALUES (${vals.join(',')})`).run({
      userId, createdAt: now, updatedAt: now, ...fields,
    })
  } else {
    const sets = Object.keys(fields).map((k) => `${k} = @${k}`).join(', ')
    db.prepare(`UPDATE users SET ${sets}, updatedAt = @updatedAt WHERE userId = @userId`).run({
      userId, updatedAt: now, ...fields,
    })
  }
}

export function isSetupDone(userId) {
  const u = getUser(userId)
  return u?.setupDone === 1
}

// ── OAuth states (CSRF protection) ────────────────────────────────────────

export function createOAuthState(userId) {
  const expiresAt = Date.now() + 10 * 60 * 1000
  const payload = {
    userId,
    expiresAt,
    nonce: randomBytes(16).toString('hex'),
  }
  const encodedPayload = base64url(JSON.stringify(payload))
  const signature = signOAuthState(encodedPayload)
  return `${encodedPayload}.${signature}`
}

export function consumeOAuthState(state) {
  if (!state || typeof state !== 'string') return null

  const [encodedPayload, signature] = state.split('.')
  if (!encodedPayload || !signature) return null
  if (!verifyOAuthState(encodedPayload, signature)) return null

  let payload
  try {
    payload = JSON.parse(base64urlDecode(encodedPayload))
  } catch {
    return null
  }

  if (!payload?.userId || !payload?.expiresAt) return null
  if (payload.expiresAt < Date.now()) return null

  return payload.userId
}

const OAUTH_STATE_SECRET =
  process.env.OAUTH_STATE_SECRET ||
  process.env.LINE_CHANNEL_SECRET ||
  process.env.GOOGLE_CLIENT_SECRET ||
  'receipt-bot-oauth-state'

function signOAuthState(encodedPayload) {
  return createHmac('sha256', OAUTH_STATE_SECRET)
    .update(encodedPayload)
    .digest('base64url')
}

function verifyOAuthState(encodedPayload, signature) {
  try {
    const expected = Buffer.from(signOAuthState(encodedPayload))
    const actual = Buffer.from(signature)
    return expected.length === actual.length && timingSafeEqual(expected, actual)
  } catch {
    return false
  }
}

function base64url(value) {
  return Buffer.from(value, 'utf8').toString('base64url')
}

function base64urlDecode(value) {
  return Buffer.from(value, 'base64url').toString('utf8')
}
