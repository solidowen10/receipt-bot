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

export async function parseReceipt(imageBase64, mimeType = 'image/jpeg') {
  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 1024,
    system: '你是一個發票解析助手。請分析發票圖片，以 JSON 格式回傳資料，不要任何多餘文字。',
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: mimeType, data: imageBase64 } },
        { type: 'text', text: `請解析這張發票/收據，回傳以下 JSON 結構：
{
  "date": "YYYY-MM-DD 格式，無法識別填 null",
  "store": "只填公司/店家主名稱。優先填有限公司、股份有限公司、公司、企業社、商行等正式名稱；若看不到正式名稱，再嘗試從招牌或 logo 判斷；若仍無法確定填 null",
  "invoice_number": "發票號碼，無法識別填 null",
  "total": 總金額數字（台幣，純數字），無法識別填 null,
  "items": [
    { "name": "品項名稱", "qty": 數量, "price": 單價, "subtotal": 小計 }
  ],
  "category": "從以下選一個最符合的：餐飲、超市、交通、娛樂、醫療、購物、住宿、其他",
  "category_confidence": 0.0 到 1.0 之間的信心分數,
  "notes": "折扣、備註等，無則填 null"
}
只回傳 JSON，不要 markdown code block。` },
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
    total:           parsed.total ?? null,
    items:           parsed.items ?? [],
    category:        autoClassified ? parsed.category : null,
    categoryConfidence: confidence,
    autoClassified,
    notes:           parsed.notes ?? null,
  }
}
