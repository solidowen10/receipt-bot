import { google } from 'googleapis'
import { upsertUser, getUser } from './db.js'

const CLIENT_ID     = process.env.GOOGLE_CLIENT_ID
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET
const APP_URL       = (process.env.APP_URL || '').replace(/\/+$/, '')
const REDIRECT_URI  = `${APP_URL}/oauth/callback`

// ── OAuth client factory ───────────────────────────────────────────────────

export function createOAuthClient() {
  return new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI)
}

export function getOAuthConfigSummary() {
  return {
    appUrl: APP_URL,
    redirectUri: REDIRECT_URI,
    hasClientId: !!CLIENT_ID,
    hasClientSecret: !!CLIENT_SECRET,
  }
}

/** Build the Google authorization URL for a given state token */
export function buildAuthUrl(state) {
  const client = createOAuthClient()
  return client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',           // force refresh_token to be returned every time
    scope: [
      'https://www.googleapis.com/auth/drive',
      'https://www.googleapis.com/auth/spreadsheets',
      'https://www.googleapis.com/auth/userinfo.email',
    ],
    state,
  })
}

/** Exchange authorization code for tokens, persist to DB */
export async function exchangeCodeForTokens(userId, code) {
  const client = createOAuthClient()
  const { tokens } = await client.getToken(code)
  await saveTokens(userId, tokens)
  return tokens
}

/** Persist tokens to DB */
async function saveTokens(userId, tokens) {
  upsertUser(userId, {
    accessToken:  tokens.access_token,
    refreshToken: tokens.refresh_token ?? undefined, // may be null on re-auth without prompt:consent
    tokenExpiry:  tokens.expiry_date ?? (Date.now() + 3600 * 1000),
  })
}

/** Get a ready-to-use, auto-refreshed OAuth2 client for a user */
export async function getAuthForUser(userId) {
  const user = getUser(userId)
  if (!user?.accessToken) throw new Error('USER_NOT_AUTHORIZED')

  const client = createOAuthClient()
  client.setCredentials({
    access_token:  user.accessToken,
    refresh_token: user.refreshToken,
    expiry_date:   user.tokenExpiry,
  })

  // Auto-refresh if expired (or within 2 min of expiry)
  if (user.tokenExpiry && user.tokenExpiry - Date.now() < 2 * 60 * 1000) {
    const { credentials } = await client.refreshAccessToken()
    await saveTokens(userId, credentials)
    client.setCredentials(credentials)
  }

  return client
}

// ── Drive folder browser (used by setup UI) ───────────────────────────────

/** List top-level Drive folders the user can write to */
export async function listDriveFolders(userId, parentId = 'root') {
  const auth = await getAuthForUser(userId)
  const drive = google.drive({ version: 'v3', auth })

  const res = await drive.files.list({
    q: `'${parentId}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
    fields: 'files(id,name)',
    orderBy: 'name',
    pageSize: 50,
  })
  return res.data.files ?? []
}

/** List Sheets files in Drive root */
export async function listSheets(userId) {
  const auth = await getAuthForUser(userId)
  const drive = google.drive({ version: 'v3', auth })

  const res = await drive.files.list({
    q: `mimeType = 'application/vnd.google-apps.spreadsheet' and trashed = false`,
    fields: 'files(id,name)',
    orderBy: 'modifiedTime desc',
    pageSize: 30,
  })
  return res.data.files ?? []
}

/** Create a new Sheets file for the user */
export async function createSheet(userId, title = '發票記帳') {
  const auth = await getAuthForUser(userId)
  const sheets = google.sheets({ version: 'v4', auth })

  const res = await sheets.spreadsheets.create({
    requestBody: {
      properties: { title },
      sheets: [{ properties: { title: '發票記錄' } }],
    },
  })
  return { id: res.data.spreadsheetId, name: title }
}

// ── Drive upload ───────────────────────────────────────────────────────────

export async function uploadToDrive(userId, imageBuffer, mimeType, filename) {
  const user = getUser(userId)
  if (!user?.driveFolder) throw new Error('Drive 資料夾尚未設定')

  const auth = await getAuthForUser(userId)
  const drive = google.drive({ version: 'v3', auth })

  // 1. Upload original image
  const imgRes = await drive.files.create({
    requestBody: { name: filename, mimeType, parents: [user.driveFolder] },
    media: { mimeType, body: bufferToStream(imageBuffer) },
    fields: 'id',
  })
  const imgFileId = imgRes.data.id

  // 2. Create a Google Doc copy → export as PDF → upload PDF
  const docCopy = await drive.files.copy({
    fileId: imgFileId,
    requestBody: {
      name: filename.replace(/\.[^.]+$/, '') + '_doc',
      mimeType: 'application/vnd.google-apps.document',
      parents: [user.driveFolder],
    },
    fields: 'id',
  })

  const ocrText = await drive.files.export(
    { fileId: docCopy.data.id, mimeType: 'text/plain' },
    { responseType: 'text' }
  ).then((r) => String(r.data ?? ''))

  const pdfBuffer = await drive.files.export(
    { fileId: docCopy.data.id, mimeType: 'application/pdf' },
    { responseType: 'arraybuffer' }
  ).then((r) => Buffer.from(r.data))

  await drive.files.delete({ fileId: docCopy.data.id }).catch(() => {})
  await drive.files.delete({ fileId: imgFileId }).catch(() => {})

  const pdfName = filename.replace(/\.[^.]+$/, '.pdf')
  const pdfRes = await drive.files.create({
    requestBody: { name: pdfName, mimeType: 'application/pdf', parents: [user.driveFolder] },
    media: { mimeType: 'application/pdf', body: bufferToStream(pdfBuffer) },
    fields: 'id,webViewLink',
  })

  await drive.permissions.create({
    fileId: pdfRes.data.id,
    requestBody: { role: 'reader', type: 'anyone' },
  })

  return {
    imageUrl: null,
    pdfUrl: pdfRes.data.webViewLink,
    ocrText,
    ocrFields: extractReceiptFieldsFromText(ocrText),
  }
}

// ── Sheets append ──────────────────────────────────────────────────────────

const HEADERS = ['時間戳記','消費日期','店家','品項','金額(NT$)','類別','發票號碼','備註','圖片連結','PDF連結']

export async function appendToSheet(userId, record) {
  const user = getUser(userId)
  if (!user?.sheetId) throw new Error('試算表尚未設定')

  const auth = await getAuthForUser(userId)
  const sheets = google.sheets({ version: 'v4', auth })
  const spreadsheetId = user.sheetId
  const sheetName = user.sheetName || '發票記錄'

  // Ensure tab + header row exist
  const meta = await sheets.spreadsheets.get({ spreadsheetId, fields: 'sheets.properties.title' })
  const tabExists = meta.data.sheets.some((s) => s.properties.title === sheetName)

  if (!tabExists) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: { requests: [{ addSheet: { properties: { title: sheetName } } }] },
    })
    await sheets.spreadsheets.values.update({
      spreadsheetId, range: `${sheetName}!A1`,
      valueInputOption: 'RAW',
      requestBody: { values: [HEADERS] },
    })
  }

  const items = record.items?.map((i) => `${i.name}×${i.qty ?? 1}`).join('、') ?? ''
  const row = [
    new Date().toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' }),
    record.date ?? '',
    record.store ?? '',
    items,
    record.total ?? '',
    record.category ?? '',
    record.invoiceNumber ?? '',
    record.notes ?? '',
    record.imageUrl ?? '',
    record.pdfUrl ?? '',
  ]

  await sheets.spreadsheets.values.append({
    spreadsheetId, range: `${sheetName}!A1`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [row] },
  })

  return `https://docs.google.com/spreadsheets/d/${spreadsheetId}`
}

// ── helpers ────────────────────────────────────────────────────────────────

import { Readable } from 'stream'
function bufferToStream(buf) {
  const r = new Readable(); r.push(buf); r.push(null); return r
}

function extractReceiptFieldsFromText(text) {
  if (!text) return {}

  const normalized = text.replace(/\r/g, '').replace(/\u3000/g, ' ').trim()
  const lines = normalized
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)

  const date = extractDate(normalized)
  const total = extractTotal(lines, normalized)
  const store = extractStore(lines)

  return {
    date: date ?? null,
    total: total ?? null,
    store: store ?? null,
  }
}

function extractDate(text) {
  const match = text.match(/(20\d{2})[\/.-](\d{1,2})[\/.-](\d{1,2})/)
  if (!match) return null

  const [, year, month, day] = match
  return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`
}

function extractTotal(lines, text) {
  const lineMatch = lines.find((line) => /總\s*計|合\s*計|應\s*付/.test(line))
  const source = lineMatch ?? text
  const amountMatch = source.match(/(?:總\s*計|合\s*計|應\s*付)[^\d]{0,10}(\d[\d,]*)/)
  if (!amountMatch) return null
  return Number(amountMatch[1].replace(/,/g, '')) || null
}

function extractStore(lines) {
  const noisePattern = /^(?:統一編號|發票|電話|地址|總計|合計|應付|日期|時間|TX|隨機碼|交易|明細|品名|數量|單價|金額)/i
  const preferred = lines.find((line) =>
    !noisePattern.test(line) &&
    /(?:公司|有限公司|股份有限公司|企業社|商行|餐廳|商店|門市|超商|藥局|診所|咖啡|早餐|便當|小吃)/.test(line)
  )
  if (preferred) return preferred

  const fallback = lines.find((line) =>
    !noisePattern.test(line) &&
    !/\d{4}[\/.-]\d{1,2}[\/.-]\d{1,2}/.test(line) &&
    !/^\d[\d\s,.:/-]*$/.test(line) &&
    line.length >= 2 &&
    line.length <= 40
  )
  return fallback ?? null
}
