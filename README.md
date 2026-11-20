# 🏓 打球啦｜匹克球報名系統

Firebase（Firestore + Cloud Functions）＋ GitHub Pages ＋ LINE Login (LIFF) ＋ LINE Bot

## 專案結構

```
lets-pickleball/
├─ docs/                  ← 前端網站（GitHub Pages 從這個資料夾發佈）
│  ├─ index.html
│  ├─ app.js              ← 網站主程式（揪團、行事曆、我的、教學、管理後台）
│  ├─ style.css
│  └─ config.js           ← ⚠️ 要填 firebaseConfig
├─ functions/             ← 後端 Cloud Functions
│  ├─ index.js            ← 登入、報名/取消、管理員 API、LINE Webhook
│  ├─ src/core.js         ← 報名 / 候補遞補 / 24 小時限制 的核心邏輯
│  ├─ src/flex.js         ← LINE 揪團字卡
│  ├─ src/line.js         ← LINE API 工具
│  ├─ src/time.js         ← 台灣時間格式化
│  └─ .env                ← LINE Login Channel ID、LIFF ID（非機密）
├─ firestore.rules        ← 資料庫存取規則
└─ firebase.json
```

## 功能

| 角色 | 功能 |
|---|---|
| 一般用戶 | LINE 登入、查看近期揪團、報名 +1 / 取消 -1、行事曆、查看自己的正取/候補狀態 |
| 管理員 | 新增 / 編輯 / 複製 / 刪除揪團、一鍵關閉/開放報名、名單中輸入名字新增人員（佔一個名額）或刪除人員、設定其他人為管理員、封鎖用戶 |
| LINE Bot | 群組輸入「揪團」（或 報名、場次、打球）→ 回覆近期 5 場字卡；按報名 +1 / 取消 -1 會跳出確認視窗，本人按「確定」才生效，完成後回覆結果與最新字卡；輸入「教學」回覆教學連結 |

**規則**
- 依報名順序排序，前 N 位為正取，其餘為候補；正取取消時候補第一位自動遞補
- 每場可勾選「開打前 24 小時內不可取消正取」（候補隨時可取消，管理員可隨時移除）
- 被封鎖的用戶無法報名
- 關閉報名的場次（🔒 已截止），一般用戶無法自行報名，只有管理員能新增人員；已報名的人仍可依規則取消
- **第一位登入網站的人會自動成為管理員**，之後的人預設是一般用戶

## 資料結構（Firestore）

- `users/{LINE userId}`：`displayName`、`pictureUrl`、`role`（admin / user）、`blocked`
- `events/{id}`：`title`、`location`、`courts`、`note`、`startAt`、`endAt`、`capacity`、`cancelLock24h`、`status`（open / closed）、`entries`（依報名順序的 `{uid, name, at}` 陣列）、`memberIds`

所有寫入都經過 Cloud Functions，前端只能讀取。

---

## 第一次部署步驟

### 1. 安裝 Git 並把專案放進 repo
```powershell
winget install Git.Git
```
裝完**重開 PowerShell**，然後：
```powershell
git config --global user.name "Under-C"
git config --global user.email "你的GitHub信箱"
cd ~
git clone https://github.com/Under-C/lets-pickleball.git
```
把這個壓縮檔裡的所有檔案（包含 `.firebaserc`、`.gitignore`、`functions/.env` 這些點開頭的檔案）解壓到 `C:\Users\q1478\lets-pickleball`。

### 2. 填寫設定
- `docs/config.js`：貼上 Firebase Console → 專案設定 → 你的應用程式 → `firebaseConfig`
- `docs/config.js` 與 `functions/.env` 的 LIFF ID、Channel ID：用 LINE Developers 的複製按鈕重新貼一次

### 3. 安裝套件並設定 LINE Bot 機密
```powershell
cd ~\lets-pickleball\functions
npm install
cd ..
firebase functions:secrets:set LINE_CHANNEL_SECRET
firebase functions:secrets:set LINE_CHANNEL_ACCESS_TOKEN
```
執行後各會要求貼上值（Messaging API channel 的 Channel secret 與 Channel access token），貼上時畫面不會顯示，貼完直接按 Enter。

### 4. 部署後端
```powershell
firebase deploy --only functions,firestore
```
第一次部署會詢問是否啟用一些 Google Cloud API，回答 `y`。完成後畫面會列出 `lineWebhook` 的網址，複製下來。

### 5. 開放「產生登入 Token」的權限（只需做一次）
Cloud Functions 需要權限才能產生 Firebase 登入 Token，否則登入時會出現 `signBlob` 權限錯誤。
1. 打開 https://console.cloud.google.com/iam-admin/iam?project=lets-pickleball
2. 找到名稱為 **Default compute service account**（`數字-compute@developer.gserviceaccount.com`）的那一列，按鉛筆圖示編輯
3. 「新增其他角色」→ 搜尋並選擇 **服務帳戶憑證建立者（Service Account Token Creator）** → 儲存
4. 打開 https://console.cloud.google.com/apis/library/iamcredentials.googleapis.com?project=lets-pickleball ，確認 **IAM Service Account Credentials API** 已啟用

### 6. 設定 LINE Webhook
LINE Developers → Messaging API channel → Messaging API 分頁：
1. Webhook URL 貼上第 4 步的 `lineWebhook` 網址 → **Verify**（應顯示 Success）
2. 打開 **Use webhook**

### 7. 發佈網站到 GitHub Pages
```powershell
cd ~\lets-pickleball
git add .
git commit -m "初始版本"
git push
```
GitHub repo → **Settings → Pages** → Source 選 **Deploy from a branch** → Branch 選 `main`、資料夾選 `/docs` → Save。
約 1 分鐘後網站會出現在 https://under-c.github.io/lets-pickleball/

### 8. 開始使用
1. 用手機 LINE 打開 `https://liff.line.me/你的LIFF_ID`，第一次登入的你會自動成為管理員
2. 到「🛠️ 管理」新增一場揪團
3. 把「打球啦」官方帳號邀請進群組，輸入「揪團」測試

> LINE Login channel 目前是 Developing 狀態，只有你自己（和 Roles 裡加入的測試者）能登入網站。正式開放前到 LINE Developers → LINE Login channel 上方把狀態切換成 **Published**。
> 群組裡用字卡報名不受這個限制。

---

## 之後更新程式
```powershell
cd ~\lets-pickleball
firebase deploy --only functions,firestore   # 有改 functions/ 或 firestore.rules 時
git add . ; git commit -m "說明改了什麼" ; git push   # 網站（docs/）會自動更新
```

## 常見問題
- **網站顯示「登入失敗：... signBlob ...」**：第 5 步的權限還沒設定，或剛設定需要等 1–2 分鐘生效
- **Bot 沒反應**：確認 Webhook 有打開、Verify 成功；在 Official Account Manager 確認「聊天」關閉、「自動回應訊息」關閉；查看錯誤紀錄 `firebase functions:log`
- **LIFF 初始化失敗**：檢查 `docs/config.js` 的 LIFF_ID，以及 LIFF 的 Endpoint URL 是否為 `https://under-c.github.io/lets-pickleball/`
