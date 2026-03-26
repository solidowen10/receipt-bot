# LINE 發票記帳機器人

拍照發票 → LINE Bot → Claude Vision 解析 → Google Drive 儲存 → Google Sheets 記錄

---

## 快速開始

### 1. 安裝依賴

```bash
npm install
cp .env.example .env
```

### 2. 設定 LINE Bot

1. 前往 [LINE Developers Console](https://developers.line.biz/)
2. 建立 Provider → 建立 Messaging API Channel
3. 取得 **Channel Secret** 和 **Channel Access Token**（Long-lived）
4. Webhook URL 設為 `https://你的網域/webhook`
5. 啟用 Webhook、關閉 Auto-reply messages

### 3. 設定 Anthropic API

前往 [console.anthropic.com](https://console.anthropic.com) 取得 API Key。

### 4. 設定 Google Service Account

1. 前往 [Google Cloud Console](https://console.cloud.google.com)
2. 建立專案 → 啟用 **Google Drive API** 和 **Google Sheets API**
3. IAM → 服務帳戶 → 建立服務帳戶
4. 下載 JSON 金鑰
5. 將整個 JSON 內容壓成一行，貼入 `GOOGLE_SERVICE_ACCOUNT_JSON`

#### 分享給 Service Account

- **Google Sheets**：開啟試算表 → 分享 → 貼上 Service Account Email（`xxx@xxx.iam.gserviceaccount.com`）→ 編輯者
- **Google Drive 資料夾**：右鍵資料夾 → 共用 → 貼上 Service Account Email → 編輯者

### 5. 填寫 .env

```
LINE_CHANNEL_ACCESS_TOKEN=...
LINE_CHANNEL_SECRET=...
ANTHROPIC_API_KEY=sk-ant-...
GOOGLE_SERVICE_ACCOUNT_JSON={"type":"service_account",...}
GOOGLE_SHEET_ID=你的試算表ID
GOOGLE_DRIVE_FOLDER_ID=你的資料夾ID
```

### 6. 啟動

```bash
# 本機開發
npm run dev

# 需要讓 LINE 能打到你的本機，使用 ngrok：
npx ngrok http 3000
# 把 ngrok 的 HTTPS URL 填到 LINE Webhook URL
```

---

## 部署建議

| 平台 | 說明 |
|------|------|
| **Railway** | 推 GitHub repo 即自動部署，免費額度足夠個人使用 |
| **Render** | 類似 Railway，有免費方案 |
| **Fly.io** | 性能較好，需稍微設定 |
| **VPS (Hetzner/DO)** | 完全控制，搭配 PM2 管理 process |

---

## Google Sheets 欄位說明

| 欄位 | 說明 |
|------|------|
| 時間戳記 | 記錄寫入時間 |
| 消費日期 | 發票上的日期 |
| 店家 | 商家名稱 |
| 品項 | 品項×數量列表 |
| 金額(NT$) | 總金額 |
| 類別 | 餐飲/超市/交通… |
| 發票號碼 | 統一發票號碼 |
| 備註 | 折扣、稅等 |
| 圖片連結 | Drive 原始圖片 URL |
| PDF連結 | Drive PDF URL |

---

## 檔案結構

```
line-receipt-bot/
├── index.js        # Fastify 伺服器入口
├── handlers.js     # LINE 訊息事件處理（核心邏輯）
├── lineClient.js   # LINE SDK 封裝（reply / push / Flex）
├── claude.js       # Anthropic Vision API 解析
├── google.js       # Drive 上傳 + Sheets 寫入
├── session.js      # 對話狀態管理（in-memory / 可換 Redis）
├── package.json
└── .env.example
```

---

## 對話流程

```
使用者傳圖片
    ↓
Claude Vision 解析
    ↓
信心度 ≥ 0.85 且類別已知？
    ├─ 是 → 直接上傳 Drive + 寫入 Sheets → 傳送完成 Flex 卡片
    └─ 否 → 顯示解析結果 + Quick Reply 類別按鈕
               ↓ 使用者點選
           上傳 Drive + 寫入 Sheets → 傳送完成 Flex 卡片
```

---

## 常見問題

**Q: Session 會不會因為重啟而消失？**
A: 會。若需要持久化，在 `session.js` 替換為 Redis（已留好註解說明）。

**Q: 要怎麼擴充類別？**
A: 修改 `claude.js` 中的 `CATEGORIES` 陣列即可，Prompt 和 Quick Reply 都會自動更新。

**Q: 圖片轉 PDF 的邏輯？**
A: 先上傳圖片到 Drive → 複製成 Google Doc → 匯出 PDF → 刪除 Doc。
若要更精確的 PDF（保留發票原樣），可改用 `pdf-lib` 在後端直接將圖片嵌入 PDF。
