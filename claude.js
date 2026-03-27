import Anthropic from '@anthropic-ai/sdk'

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

export const CATEGORIES = [
  { value: '餐飲',   label: '🍜 餐飲' },
  { value: '超市',   label: '🛒 超市' },
  { value: '交通',   label: '🚌 交通' },
  { value: '娛樂',   label: '🎬 娛樂' },
  { value: '醫療',   label: '💊 醫療' },
  { value: '購物',   label: '🛍️ 購物' },
  { value: '住宿',   label: '🏠 住宿' },
  { value: '其他',   label: '📌 其他' },
]

const KNOWN_VALUES = new Set(CATEGORIES.map((c) => c.value))
const CONFIDENCE_THRESHOLD = 0.85

const PROMPT = `請解析這張台灣發票或收據圖片，回傳以下 JSON 結構。只回傳 JSON，不要 markdown code block。

{
  "date": "YYYY-MM-DD 格式。若看到民國年份請換算為西元（民國年+1911）。無法識別填 null",
  "store": "只填公司/店家主名稱。優先填有限公司、股份有限公司、公司、企業社、商行等正式名稱；若看不到正式名稱，再嘗試從招牌或 logo 判斷；若仍無法確定填 null",
  "invoice_number": "統一發票號碼（如 XY80695113），無法識別填 null",
  "total": 總金額純數字（台幣，去掉 $ 和逗號），無法識別填 null,
  "items": [
    { "name": "品項名稱", "qty": 數量, "price": 單價, "subtotal": 小計 }
  ],
  "category": "從以下選一個最符合的：餐飲、超市、交通、娛樂、醫療、購物、住宿、其他",
  "category_confidence": 0.0 到 1.0 之間的信心分數,
  "notes": "折扣、稅額、備註等，無則填 null"
}

【尋找金額的重要規則】
- 台灣傳統收銀機發票的總金額通常不在品項旁邊，而是在發票下半部的合計區塊
- 若看到「總計」，總金額優先取「總計」右邊或正下方緊接的那個最終數字
- 對像圖片中這種格式，請不要取品項列或中間過程數字，要取「總計」後面的最後應付金額
- 若同區塊還有「銷售額」、「營業稅」、「合計」等多個金額，優先順序為：
  1. 總計後面的最終數字
  2. 應付 / 實收 / 應收
  3. 合計
- 金額可能寫成 "$1,914"、"$ 1,914"、"總計 1914"、或上下排列；請回傳純數字

【日期規則】
- 民國115年 = 西元2026年（民國年 + 1911）
- 若只有年月沒有日，填該月1日

【發票號碼規則】
- 通常是兩個英文字母加八位數字，例如 XY80695113

【店家規則】
- 店家請盡量只保留公司主名稱，不要把地址、電話、統編、分店代碼一起帶進去
- 若正式公司名稱看不清楚，可參考印章、抬頭或 logo
- 若仍無法確定，請填 null`

function toNumber(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value !== 'string') return null

  const digits = value.replace(/[^\d.-]/g, '')
  if (!digits) return null

  const num = Number(digits)
  return Number.isFinite(num) ? num : null
}

export async function parseReceipt(imageBase64, mimeType = 'image/jpeg') {
  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 1024,
    system: '你是一個專門解析台灣發票和收據的助手。請仔細閱讀圖片中的所有文字，以 JSON 格式回傳資料，不要任何多餘文字或 markdown。',
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: mimeType, data: imageBase64 } },
        { type: 'text', text: PROMPT },
      ],
    }],
  })

  const raw = response.content.map((b) => (b.type === 'text' ? b.text : '')).join('')
  const parsed = JSON.parse(raw.replace(/```json|```/g, '').trim())

  const confidence    = parsed.category_confidence ?? 0
  const categoryKnown = KNOWN_VALUES.has(parsed.category)
  const autoClassified = categoryKnown && confidence >= CONFIDENCE_THRESHOLD

  return {
    date:            parsed.date ?? null,
    store:           parsed.store ?? null,
    invoiceNumber:   parsed.invoice_number ?? null,
    total:           toNumber(parsed.total),
    items:           (parsed.items ?? []).map((item) => ({
      name: item?.name ?? null,
      qty: toNumber(item?.qty),
      price: toNumber(item?.price),
      subtotal: toNumber(item?.subtotal),
    })),
    category:        autoClassified ? parsed.category : null,
    categoryConfidence: confidence,
    autoClassified,
    notes:           parsed.notes ?? null,
  }
}
