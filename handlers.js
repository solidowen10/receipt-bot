import { blobClient, replyText, replyConfirmation, pushCategory, pushText } from './lineClient.js'
import { parseReceipt, CATEGORIES } from './claude.js'
import { uploadToDrive, appendToSheet } from './google.js'
import { getSession, setSession, clearSession } from './session.js'
import { isSetupDone } from './db.js'

const APP_URL = process.env.APP_URL

// Build the setup message with a clear instruction to open in external browser.
// Google blocks OAuth inside LINE's built-in WebView (disallowed_useragent).
function setupMsg(userId, prefix = '👋 請先完成設定後再開始使用') {
  const url = `${APP_URL}/auth?userId=${encodeURIComponent(userId)}`
  return (
    `${prefix}\n\n` +
    `🔗 ${url}\n\n` +
    `⚠️ 請長按連結 → 選擇「用瀏覽器開啟」\n` +
    `（必須用 Safari / Chrome 開啟，LINE 內建瀏覽器無法完成 Google 授權）`
  )
}

export async function handleMessage(event) {
  if (event.type !== 'message') return
  const userId = event.source.userId
  const replyToken = event.replyToken

  try {
    if (event.message.type === 'image') {
      await handleImage(userId, replyToken, event.message.id)
      return
    }
    if (event.message.type === 'text') {
      await handleText(userId, replyToken, event.message.text)
      return
    }
  } catch (err) {
    console.error('Handler error:', err)
    const notify = event.message.type === 'image'
      ? (text) => pushText(userId, text)
      : (text) => replyText(replyToken, text)

    if (err.message === 'USER_NOT_AUTHORIZED') {
      await notify(setupMsg(userId, '⚠️ Google 授權已失效，請重新設定'))
    } else {
      await notify('❌ 處理時發生錯誤：' + err.message)
    }
    clearSession(userId)
  }
}

// ── Image ────────────────────────────────────────────────────────────────────

async function handleImage(userId, replyToken, messageId) {
  if (!isSetupDone(userId)) {
    await replyText(replyToken, setupMsg(userId))
    return
  }

  await replyText(replyToken, '📷 收到發票！解析中，請稍候...')

  const imageStream = await blobClient.getMessageContent(messageId)
  const chunks = []
  for await (const chunk of imageStream) chunks.push(chunk)
  const imageBuffer = Buffer.concat(chunks)
  const imageBase64 = imageBuffer.toString('base64')
  const mimeType = 'image/jpeg'

  const parsed = await parseReceipt(imageBase64, mimeType)

  if (parsed.autoClassified) {
    await saveAndNotify(userId, null, { ...parsed, imageBase64, imageBuffer, mimeType })
    return
  }

  setSession(userId, {
    state: 'awaiting_category',
    parsedData: parsed,
    imageBase64,
    imageBuffer: Array.from(imageBuffer),
    mimeType,
  })
  await pushCategory(userId, parsed, CATEGORIES)
}

// ── Text ─────────────────────────────────────────────────────────────────────

async function handleText(userId, replyToken, text) {
  if (text.trim() === '/setup') {
    await replyText(replyToken,
      setupMsg(userId, isSetupDone(userId) ? '⚙️ 重新設定 Google Drive / Sheets' : '👋 請先完成設定')
    )
    return
  }

  if (text.startsWith('__cat__')) {
    const category = text.replace('__cat__', '')
    const session = getSession(userId)
    if (!session || session.state !== 'awaiting_category') {
      await replyText(replyToken, '⚠️ 對話已逾時，請重新傳送發票圖片。')
      return
    }
    await saveAndNotify(userId, replyToken, {
      ...session.parsedData,
      category,
      imageBase64: session.imageBase64,
      imageBuffer: Buffer.from(session.imageBuffer),
      mimeType: session.mimeType,
    })
    return
  }

  await replyText(replyToken,
    isSetupDone(userId)
      ? '📸 直接傳發票照片給我，我就會幫你記帳！\n\n傳送 /setup 可以修改 Google Drive / Sheets 設定。'
      : setupMsg(userId)
  )
}

// ── Save + notify ─────────────────────────────────────────────────────────────

async function saveAndNotify(userId, replyToken, data) {
  const { imageBuffer, mimeType, date, store, ...rest } = data

  const safeStore = (store ?? 'unknown').replace(/[/\\?%*:|"<>]/g, '-')
  const safeDate  = date ?? new Date().toISOString().split('T')[0]
  const filename  = `${safeDate}_${safeStore}.jpg`

  const { imageUrl, pdfUrl } = await uploadToDrive(userId, imageBuffer, mimeType, filename)
  const record = { ...rest, date, store, imageUrl, pdfUrl }

  const sheetUrl = await appendToSheet(userId, record)

  clearSession(userId)

  if (replyToken) {
    await replyConfirmation(replyToken, record, sheetUrl)
  } else {
    await pushConfirmation(userId, record, sheetUrl)
  }
}

async function pushConfirmation(userId, record, sheetUrl) {
  const text = [
    '✅ 記帳完成！',
    `📅 ${record.date ?? '-'}　🏪 ${record.store ?? '-'}`,
    `💰 NT$ ${record.total ?? '-'}　🏷️ ${record.category ?? '-'}`,
    '',
    `📊 查看記錄：${sheetUrl}`,
    record.pdfUrl ? `📄 發票 PDF：${record.pdfUrl}` : '',
  ].filter(Boolean).join('\n')

  await pushText(userId, text)
}
