import * as line from '@line/bot-sdk'

const channelAccessToken = process.env.LINE_CHANNEL_ACCESS_TOKEN
const channelSecret = process.env.LINE_CHANNEL_SECRET

console.log('LINE env check:', {
  hasAccessToken: !!channelAccessToken,
  hasChannelSecret: !!channelSecret,
})

if (!channelAccessToken) {
  throw new Error('Missing LINE_CHANNEL_ACCESS_TOKEN')
}

if (!channelSecret) {
  throw new Error('Missing LINE_CHANNEL_SECRET')
}

const config = {
  channelAccessToken,
  channelSecret,
}

export const client = new line.messagingApi.MessagingApiClient(config)
export const blobClient = new line.messagingApi.MessagingApiBlobClient(config)
export const middleware = line.middleware(config)

export function validateSignature(body, signature) {
  if (!signature || typeof body !== 'string') return false
  return line.validateSignature(body, config.channelSecret, signature)
}

export async function replyText(replyToken, text) {
  return client.replyMessage({
    replyToken,
    messages: [{ type: 'text', text }],
  })
}

export async function pushText(to, text) {
  return client.pushMessage({
    to,
    messages: [{ type: 'text', text }],
  })
}

export async function askCategory(replyToken, parsedData, categories) {
  return sendCategoryPrompt(
    (messages) => client.replyMessage({ replyToken, messages }),
    parsedData,
    categories
  )
}

export async function pushCategory(to, parsedData, categories) {
  return sendCategoryPrompt(
    (messages) => client.pushMessage({ to, messages }),
    parsedData,
    categories
  )
}

function sendCategoryPrompt(send, parsedData, categories) {
  const preview = [
    `📅 日期：${parsedData.date ?? '無法識別'}`,
    `🏪 店家：${parsedData.store ?? '無法識別'}`,
    `💰 金額：NT$ ${parsedData.total ?? '?'}`,
    '',
    '請問這筆消費要歸入哪個類別？',
  ].join('\n')

  return send([{
      type: 'text',
      text: preview,
      quickReply: {
        items: categories.map((cat) => ({
          type: 'action',
          action: { type: 'message', label: cat.label, text: `__cat__${cat.value}` },
        })),
      },
    }])
}

export async function replyConfirmation(replyToken, record, sheetUrl, reconfigureUrl) {
  const bodyRows = [
    row('日期', record.date ?? '-'),
    row('店家', record.store ?? '-', true),
    row('類別', record.category ?? '-'),
    { type: 'separator', margin: 'md' },
    {
      type: 'box', layout: 'horizontal', margin: 'md', contents: [
        { type: 'text', text: '總金額', size: 'md', flex: 1, weight: 'bold' },
        { type: 'text', text: `NT$ ${record.total ?? '-'}`, size: 'md', color: '#06C755', flex: 2, align: 'end', weight: 'bold' },
      ],
    },
    { type: 'separator', margin: 'md' },
    {
      type: 'box', layout: 'vertical', margin: 'md', spacing: 'sm', contents: [
        { type: 'text', text: '繼續記帳：直接再上傳照片即可', size: 'sm', color: '#555555', wrap: true },
        { type: 'text', text: '要換資料夾：請點下方「重新選擇資料夾」', size: 'sm', color: '#555555', wrap: true },
      ],
    },
  ]

  const footerBtns = []
  if (record.pdfUrl) {
    footerBtns.push({ type: 'button', style: 'link', height: 'sm', action: { type: 'uri', label: '查看發票 PDF', uri: record.pdfUrl } })
  }
  footerBtns.push({ type: 'button', style: 'link', height: 'sm', action: { type: 'uri', label: '查看 Google Sheets', uri: sheetUrl } })
  footerBtns.push({ type: 'button', style: 'primary', height: 'sm', color: '#6517ab', action: { type: 'uri', label: '重新選擇資料夾', uri: reconfigureUrl } })

  return client.replyMessage({
    replyToken,
    messages: [{
      type: 'flex',
      altText: `✅ 記帳完成 ${record.store ?? ''} NT$${record.total ?? ''}`,
      contents: {
        type: 'bubble',
        header: {
          type: 'box', layout: 'vertical', backgroundColor: '#6517ab', paddingAll: 'md',
          contents: [{ type: 'text', text: '✅ 記帳完成', color: '#FFFFFF', size: 'lg', weight: 'bold' }],
        },
        body: { type: 'box', layout: 'vertical', spacing: 'sm', contents: bodyRows },
        footer: { type: 'box', layout: 'vertical', spacing: 'sm', contents: footerBtns },
      },
    }],
  })
}

function row(label, value, wrap = false) {
  return {
    type: 'box', layout: 'horizontal', contents: [
      { type: 'text', text: label, size: 'sm', color: '#888888', flex: 1 },
      { type: 'text', text: value,  size: 'sm', flex: 2, align: 'end', wrap },
    ],
  }
}
