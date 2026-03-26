import { google } from 'googleapis'
import { upsertUser, getUser } from './db.js'

const CLIENT_ID     = process.env.GOOGLE_CLIENT_ID
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET
const REDIRECT_URI  = `${process.env.APP_URL}/oauth/callback`

// ── OAuth client factory ───────────────────────────────────────────────────

export function createOAuthClient() {
  return new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI)
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
    fields: 'id,webViewLink',
  })
  const imgFileId = imgRes.data.id

  await drive.permissions.create({
    fileId: imgFileId,
    requestBody: { role: 'reader', type: 'anyone' },
  })

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

  const pdfBuffer = await drive.files.export(
    { fileId: docCopy.data.id, mimeType: 'application/pdf' },
    { responseType: 'arraybuffer' }
  ).then((r) => Buffer.from(r.data))

  await drive.files.delete({ fileId: docCopy.data.id }).catch(() => {})

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

  return { imageUrl: imgRes.data.webViewLink, pdfUrl: pdfRes.data.webViewLink }
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
