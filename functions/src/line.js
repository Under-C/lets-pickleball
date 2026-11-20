// LINE API 小工具（直接用 fetch，不需要額外套件）
const crypto = require("node:crypto");

// 驗證 Webhook 簽章，確認請求真的來自 LINE
function verifySignature(rawBody, signature, channelSecret) {
  if (!rawBody || !signature) return false;
  const expected = crypto.createHmac("sha256", channelSecret).update(rawBody).digest("base64");
  const a = Buffer.from(expected);
  const b = Buffer.from(String(signature));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// 驗證 LIFF 取得的 ID Token，回傳 { sub, name, picture }
async function verifyIdToken(idToken, channelId) {
  const res = await fetch("https://api.line.me/oauth2/v2.1/verify", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ id_token: idToken, client_id: channelId }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(body.error_description || "LINE ID Token 驗證失敗");
    err.lineError = body.error_description || "";
    throw err;
  }
  return body;
}

async function reply(replyToken, messages, accessToken) {
  const res = await fetch("https://api.line.me/v2/bot/message/reply", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` },
    body: JSON.stringify({ replyToken, messages: [].concat(messages) }),
  });
  if (!res.ok) {
    console.error("LINE reply failed", res.status, await res.text());
  }
}

// 依照訊息來源（群組 / 多人聊天室 / 一對一）取得使用者名稱與頭像
async function getProfile(source, accessToken) {
  const uid = source.userId;
  let url = `https://api.line.me/v2/bot/profile/${uid}`;
  if (source.type === "group") url = `https://api.line.me/v2/bot/group/${source.groupId}/member/${uid}`;
  if (source.type === "room") url = `https://api.line.me/v2/bot/room/${source.roomId}/member/${uid}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!res.ok) return { displayName: "", pictureUrl: undefined };
  const p = await res.json();
  return { displayName: p.displayName || "", pictureUrl: p.pictureUrl || "" };
}

module.exports = { verifySignature, verifyIdToken, reply, getProfile };
