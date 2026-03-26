import * as line from '@line/bot-sdk'

const config = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret:      process.env.LINE_CHANNEL_SECRET,
}

export const client     = new line.messagingApi.MessagingApiClient(config)
export const blobClient = new line.messagingApi.MessagingApiBlobClient(config)
export const middleware = line.middleware(config)

export function validateSignature(body, signature) {
  return line.validateSignature(body, config.channelSecret, signature)
}

export async function replyText(replyToken, text) {
  return client.replyMessage({ replyToken, messages: [{ type: 'text', text }] })
}

export async function pushText(userId, text) {
  return client.pushMessage({ to: userId, messages: [{ type: 'text', text }] })
}

export async function askCategory(replyToken, parsedData, categories) {
  const preview = [
    `📅 日期：${parsedData.date ?? '無法識別'}`,
    `🏪 店家：${parsedData.store ?? '無法識別'}`,
    `💰 金額：NT$ ${parsedData.total ?? '?'}`,
    '',
    '請問這筆消費要歸入哪個類別？',
  ].join('\n')

  return client.replyMessage({
    replyToken,
    messages: [{
      type: 'text',
      text: preview,
      quickReply: {
        items: categories.map((cat) => ({
          type: 'action',
          action: { type: 'message', label: cat.label, text: `__cat__${cat.value}` },
        })),
      },
    }],
  })
}

export async function replyConfirmation(replyToken, record, sheetUrl) {
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
  ]

  const footerBtns = []
  if (record.pdfUrl) {
    footerBtns.push({ type: 'button', style: 'link', height: 'sm', action: { type: 'uri', label: '查看發票 PDF', uri: record.pdfUrl } })
  }
  footerBtns.push({ type: 'button', style: 'link', height: 'sm', action: { type: 'uri', label: '查看 Google Sheets', uri: sheetUrl } })

  return client.replyMessage({
    replyToken,
    messages: [{
      type: 'flex',
      altText: `✅ 記帳完成 ${record.store ?? ''} NT$${record.total ?? ''}`,
      contents: {
        type: 'bubble',
        header: {
          type: 'box', layout: 'vertical', backgroundColor: '#06C755', paddingAll: 'md',
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
