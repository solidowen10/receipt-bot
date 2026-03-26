import Fastify from 'fastify'
import staticPlugin from '@fastify/static'
import path from 'path'
import { fileURLToPath } from 'url'

import { validateSignature, pushText } from './lineClient.js'
import { handleMessage } from './handlers.js'
import { buildAuthUrl, exchangeCodeForTokens, listDriveFolders, listSheets, createSheet, getOAuthConfigSummary } from './google.js'
import { createOAuthState, consumeOAuthState, upsertUser, getUser } from './db.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// Parse body as raw string so we can validate LINE's HMAC signature,
// then also expose the parsed JSON on req.body for route handlers.
const app = Fastify({
  logger: true,
  bodyLimit: 10 * 1024 * 1024,
})

app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, rawBody, done) => {
  try {
    req.rawBody = rawBody
    done(null, JSON.parse(rawBody))
  } catch (e) {
    done(e)
  }
})

// Serve setup UI
app.register(staticPlugin, { root: __dirname })

app.get('/', async (req, reply) => {
  return reply.send({ ok: true, service: 'line-receipt-bot' })
})

app.get('/health', async (req, reply) => {
  return reply.send({ ok: true })
})

app.get('/setup/', async (req, reply) => {
  return reply.type('text/html').sendFile('index.html')
})

// ── LINE Webhook ────────────────────────────────────────────────────────────

app.post('/webhook', async (req, reply) => {
  const signature = req.headers['x-line-signature']
  const rawBody = req.rawBody ?? ''

  if (!validateSignature(rawBody, signature)) {
    return reply.status(403).send({ error: 'Invalid signature' })
  }

  const events = req.body?.events ?? []
  await Promise.all(events.map(handleMessage))
  reply.send({ status: 'ok' })
})

// ── OAuth flow ──────────────────────────────────────────────────────────────

/** Step 1: LINE Bot sends user here via /auth?userId=xxx */
app.get('/auth', async (req, reply) => {
  const { userId } = req.query
  if (!userId) return reply.status(400).send('Missing userId')

  const state = createOAuthState(userId)
  const url = buildAuthUrl(state)
  reply.redirect(url)
})

/** Step 2: Google redirects back here with code + state */
app.get('/oauth/callback', async (req, reply) => {
  const { code, state, error } = req.query

  if (error) {
    return reply.type('text/html').send(errorPage('授權被拒絕', '請關閉此頁面，回到 LINE 重新嘗試。'))
  }

  const userId = consumeOAuthState(state)
  if (!userId) {
    return reply.type('text/html').send(errorPage('連結已失效', '請回到 LINE 重新發送 /setup 取得新連結。'))
  }

  if (!code) {
    return reply.type('text/html').send(errorPage('缺少授權碼', 'Google 沒有回傳授權碼，請回到 LINE 重新嘗試。'))
  }

  try {
    await exchangeCodeForTokens(userId, code)
  } catch (err) {
    req.log.error({
      msg: 'Google OAuth token exchange failed',
      oauth: getOAuthConfigSummary(),
      error: err?.message,
      response: err?.response?.data,
      codeLength: typeof code === 'string' ? code.length : null,
    })

    return reply.type('text/html').send(
      errorPage(
        'Google 授權失敗',
        '無法完成 Google token 交換。請確認 Google OAuth 的 Redirect URI 與 APP_URL 完全一致，然後重新從 LINE 的 /setup 開始。'
      )
    )
  }

  // Redirect to the setup UI (pass userId via query for the SPA to use)
  reply.redirect(`/setup/?userId=${encodeURIComponent(userId)}`)
})

// ── Setup API (called by the setup SPA) ────────────────────────────────────

/** List user's Drive folders */
app.get('/api/drive/folders', async (req, reply) => {
  const { userId, parentId } = req.query
  if (!userId) return reply.status(400).send({ error: 'Missing userId' })
  try {
    const folders = await listDriveFolders(userId, parentId)
    reply.send({ folders })
  } catch (e) {
    reply.status(500).send({ error: e.message })
  }
})

/** List user's Sheets */
app.get('/api/sheets', async (req, reply) => {
  const { userId } = req.query
  if (!userId) return reply.status(400).send({ error: 'Missing userId' })
  try {
    const sheets = await listSheets(userId)
    reply.send({ sheets })
  } catch (e) {
    reply.status(500).send({ error: e.message })
  }
})

/** Create a new Sheet for the user */
app.post('/api/sheets/create', async (req, reply) => {
  const { userId, title, driveFolder } = req.body ?? {}
  if (!userId) return reply.status(400).send({ error: 'Missing userId' })
  try {
    const sheet = await createSheet(userId, title || '發票記帳', driveFolder || null)
    reply.send({ sheet })
  } catch (e) {
    reply.status(500).send({ error: e.message })
  }
})

/** Save final config — called when user clicks "完成設定" */
app.post('/api/setup/save', async (req, reply) => {
  const { userId, driveFolder, driveFolderName, sheetId, sheetName } = req.body ?? {}
  if (!userId || !driveFolder || !sheetId) {
    return reply.status(400).send({ error: 'Missing required fields' })
  }
  upsertUser(userId, {
    driveFolder,
    driveFolderName: driveFolderName ?? '',
    sheetId,
    sheetName: sheetName ?? '',
    setupDone: 1,
  })

  // Notify the user in LINE
  await pushText(userId,
    '✅ 設定完成！\n\n' +
    `📁 Drive 資料夾：${driveFolderName ?? driveFolder}\n` +
    `📊 試算表：${sheetName ?? '發票記錄'}\n\n` +
    '現在開始傳發票圖片給我，就會自動幫你記帳囉！'
  )

  reply.send({ ok: true })
})

/** Get current user config (for showing current settings in UI) */
app.get('/api/setup/config', async (req, reply) => {
  const { userId } = req.query
  if (!userId) return reply.status(400).send({ error: 'Missing userId' })
  const user = getUser(userId)
  if (!user) return reply.status(404).send({ error: 'User not found' })
  reply.send({
    setupDone:       user.setupDone === 1,
    driveFolder:     user.driveFolder,
    driveFolderName: user.driveFolderName,
    sheetId:         user.sheetId,
    sheetName:       user.sheetName ?? '',
  })
})

// ── Start ───────────────────────────────────────────────────────────────────

const port = process.env.PORT || 3000
await app.listen({ port, host: '0.0.0.0' })
console.log(`LINE Receipt Bot v2 running on port ${port}`)

// ── HTML helpers ────────────────────────────────────────────────────────────

function errorPage(title, body) {
  return `<!DOCTYPE html><html lang="zh-TW"><head><meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${title}</title>
  <style>body{font-family:sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#f5f5f5}
  .box{background:#fff;padding:32px;border-radius:12px;max-width:360px;text-align:center}
  h2{color:#e05252;margin-bottom:12px}p{color:#666;line-height:1.6}</style></head>
  <body><div class="box"><h2>⚠️ ${title}</h2><p>${body}</p></div></body></html>`
}
