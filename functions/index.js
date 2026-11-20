// 打球啦 匹克球報名系統 - Cloud Functions 入口
const { initializeApp } = require("firebase-admin/app");
const { getAuth } = require("firebase-admin/auth");
const { getFirestore, FieldValue, Timestamp } = require("firebase-admin/firestore");
const { setGlobalOptions } = require("firebase-functions/v2");
const { onCall, onRequest, HttpsError } = require("firebase-functions/v2/https");
const { defineSecret, defineString } = require("firebase-functions/params");

const core = require("./src/core");
const line = require("./src/line");
const { eventsCarousel, eventMessage, confirmMessage } = require("./src/flex");
const { fmtRange } = require("./src/time");

initializeApp();
setGlobalOptions({ region: "asia-east1", maxInstances: 5 });

// 機密（用 firebase functions:secrets:set 設定）
const LINE_CHANNEL_SECRET = defineSecret("LINE_CHANNEL_SECRET");
const LINE_CHANNEL_ACCESS_TOKEN = defineSecret("LINE_CHANNEL_ACCESS_TOKEN");
// 一般設定（寫在 functions/.env）
const LINE_LOGIN_CHANNEL_ID = defineString("LINE_LOGIN_CHANNEL_ID");
const LIFF_ID = defineString("LIFF_ID");
const SITE_URL = defineString("SITE_URL"); // 網站網址，字卡圖示從這裡讀取

// Bot 關鍵字
const LIST_KEYWORDS = ["揪團", "報名", "場次", "打球"];
const HELP_KEYWORDS = ["教學", "說明", "help"];

const db = () => getFirestore();

// ---------- 共用檢查 ----------
function requireAuth(req) {
  if (!req.auth) throw new HttpsError("unauthenticated", "請先登入");
  return req.auth.uid;
}

async function getUser(uid) {
  const snap = await db().doc(`users/${uid}`).get();
  return snap.exists ? snap.data() : null;
}

async function requireAdmin(req) {
  const uid = requireAuth(req);
  const user = await getUser(uid);
  if (!user || user.role !== "admin") throw new HttpsError("permission-denied", "只有管理員可以執行這個操作");
  return { uid, user };
}

function toHttpsError(err) {
  if (err instanceof HttpsError) return err;
  if (err instanceof core.AppError) return new HttpsError("failed-precondition", err.message, { code: err.code });
  console.error(err);
  return new HttpsError("internal", "系統發生錯誤，請稍後再試");
}

// ---------- 登入：LIFF ID Token 換 Firebase Custom Token ----------
exports.lineLogin = onCall(async (req) => {
  const idToken = req.data && req.data.idToken;
  if (!idToken) throw new HttpsError("invalid-argument", "缺少 idToken");
  let profile;
  try {
    profile = await line.verifyIdToken(idToken, LINE_LOGIN_CHANNEL_ID.value());
  } catch (e) {
    throw new HttpsError("unauthenticated", "LINE 登入驗證失敗，請重新登入", { reason: e.lineError || e.message });
  }
  const uid = profile.sub;
  const user = await core.upsertUser({ uid, displayName: profile.name, pictureUrl: profile.picture || "" });
  const token = await getAuth().createCustomToken(uid);
  return { token, role: user.role, blocked: !!user.blocked };
});

// ---------- 一般用戶：報名 / 取消 ----------
exports.joinEvent = onCall(async (req) => {
  const uid = requireAuth(req);
  try {
    const user = await getUser(uid);
    const r = await core.joinEvent({ eventId: String(req.data.eventId), uid, name: user && user.displayName });
    return { result: r.result, position: r.position };
  } catch (e) {
    throw toHttpsError(e);
  }
});

exports.cancelEvent = onCall(async (req) => {
  const uid = requireAuth(req);
  try {
    const r = await core.cancelEvent({ eventId: String(req.data.eventId), uid });
    return { result: r.result, promoted: r.promoted ? r.promoted.name : null };
  } catch (e) {
    throw toHttpsError(e);
  }
});

// ---------- 管理員 ----------
function cleanStr(v, max) {
  return String(v == null ? "" : v).trim().slice(0, max);
}

exports.adminSaveEvent = onCall(async (req) => {
  const { uid } = await requireAdmin(req);
  const d = req.data || {};
  const startAt = Number(d.startAt);
  const endAt = Number(d.endAt);
  const capacity = Number(d.capacity);
  const data = {
    title: cleanStr(d.title, 40) || "匹克球揪團",
    location: cleanStr(d.location, 60),
    courts: cleanStr(d.courts, 120),
    note: cleanStr(d.note, 200),
    capacity,
    cancelLock24h: !!d.cancelLock24h,
    status: d.status === "closed" ? "closed" : "open",
  };
  if (!data.location) throw new HttpsError("invalid-argument", "請填寫地點");
  if (!Number.isFinite(startAt) || !Number.isFinite(endAt) || endAt <= startAt) {
    throw new HttpsError("invalid-argument", "開始 / 結束時間不正確");
  }
  if (!Number.isInteger(capacity) || capacity < 1 || capacity > 200) {
    throw new HttpsError("invalid-argument", "人數上限需為 1–200 的整數");
  }
  data.startAt = Timestamp.fromMillis(startAt);
  data.endAt = Timestamp.fromMillis(endAt);
  data.updatedAt = FieldValue.serverTimestamp();

  if (d.id) {
    const ref = db().doc(`events/${String(d.id)}`);
    if (!(await ref.get()).exists) throw new HttpsError("not-found", "找不到這場揪團");
    await ref.update(data);
    return { id: ref.id };
  }
  const ref = await db().collection("events").add({
    ...data,
    entries: [],
    memberIds: [],
    createdAt: FieldValue.serverTimestamp(),
    createdBy: uid,
  });
  return { id: ref.id };
});

exports.adminDeleteEvent = onCall(async (req) => {
  await requireAdmin(req);
  await db().doc(`events/${String(req.data.eventId)}`).delete();
  return { ok: true };
});

exports.adminRemoveEntry = onCall(async (req) => {
  await requireAdmin(req);
  try {
    const r = await core.cancelEvent({ eventId: String(req.data.eventId), uid: String(req.data.uid), force: true });
    return { promoted: r.promoted ? r.promoted.name : null };
  } catch (e) {
    throw toHttpsError(e);
  }
});

// 管理員手動新增報名者（只填名字）
exports.adminAddEntry = onCall(async (req) => {
  const { uid } = await requireAdmin(req);
  const name = cleanStr(req.data.name, 30);
  if (!name) throw new HttpsError("invalid-argument", "請輸入名字");
  try {
    const r = await core.adminAddEntry({ eventId: String(req.data.eventId), name, by: uid });
    return { position: r.position };
  } catch (e) {
    throw toHttpsError(e);
  }
});

// 管理員開放 / 關閉報名
exports.adminSetEventStatus = onCall(async (req) => {
  await requireAdmin(req);
  const ref = db().doc(`events/${String(req.data.eventId)}`);
  if (!(await ref.get()).exists) throw new HttpsError("not-found", "找不到這場揪團");
  const status = req.data.status === "closed" ? "closed" : "open";
  await ref.update({ status, updatedAt: FieldValue.serverTimestamp() });
  return { status };
});

exports.adminSetUser = onCall(async (req) => {
  const { uid: me } = await requireAdmin(req);
  const target = String(req.data.uid || "");
  if (!target) throw new HttpsError("invalid-argument", "缺少使用者");
  if (target === me) throw new HttpsError("failed-precondition", "不能變更自己的權限或封鎖自己");
  const ref = db().doc(`users/${target}`);
  if (!(await ref.get()).exists) throw new HttpsError("not-found", "找不到這位使用者");
  const patch = {};
  if (req.data.role !== undefined) patch.role = req.data.role === "admin" ? "admin" : "user";
  if (req.data.blocked !== undefined) patch.blocked = !!req.data.blocked;
  await ref.update(patch);
  return { ok: true };
});

// ---------- LINE Bot Webhook ----------
exports.lineWebhook = onRequest(
  { secrets: [LINE_CHANNEL_SECRET, LINE_CHANNEL_ACCESS_TOKEN], invoker: "public" },
  async (req, res) => {
    if (req.method !== "POST") {
      res.status(405).send("Method Not Allowed");
      return;
    }
    const ok = line.verifySignature(req.rawBody, req.get("x-line-signature"), LINE_CHANNEL_SECRET.value());
    if (!ok) {
      res.status(401).send("Bad signature");
      return;
    }
    const events = (req.body && req.body.events) || [];
    await Promise.all(
      events.map((ev) =>
        handleLineEvent(ev).catch((e) => console.error("handleLineEvent error", e))
      )
    );
    res.status(200).send("ok");
  }
);

async function handleLineEvent(ev) {
  const token = LINE_CHANNEL_ACCESS_TOKEN.value();
  const liffId = LIFF_ID.value();
  const iconUrl = `${SITE_URL.value().replace(/\/$/, "")}/pickleball.png`;

  if (ev.type === "message" && ev.message.type === "text") {
    const msg = ev.message.text.trim();
    if (LIST_KEYWORDS.includes(msg)) {
      const list = await core.upcomingEvents(5);
      if (!list.length) {
        await line.reply(ev.replyToken, { type: "text", text: "目前沒有即將到來的揪團喔！" }, token);
      } else {
        await line.reply(ev.replyToken, eventsCarousel(list, liffId, iconUrl), token);
      }
    } else if (HELP_KEYWORDS.includes(msg)) {
      await line.reply(
        ev.replyToken,
        { type: "text", text: `📖 使用教學\nhttps://liff.line.me/${liffId}?view=help\n\n在群組輸入「揪團」即可查看近期場次並報名。` },
        token
      );
    }
    return;
  }

  if (ev.type === "postback") {
    const params = new URLSearchParams(ev.postback.data);
    const action = params.get("a");
    const eventId = params.get("e");
    // 「先不要 / 按錯了」：不需要回覆
    if (!eventId || !["join", "cancel", "cjoin", "ccancel"].includes(action)) return;

    const sayText = (t) => line.reply(ev.replyToken, { type: "text", text: t }, token);
    const userId = ev.source && ev.source.userId;
    if (!userId) {
      await sayText("⚠️ 無法取得你的 LINE 身分，請先將「打球啦」加為好友後再試一次");
      return;
    }

    // 確認按鈕只有本人按才有效
    if ((action === "cjoin" || action === "ccancel") && params.get("u") !== userId) {
      await sayText(`⚠️ 這個確認按鈕不是給你的喔，請點字卡上的「${action === "cjoin" ? "報名 +1" : "取消 -1"}」`);
      return;
    }

    const profile = await line.getProfile(ev.source, token);
    const user = await core.upsertUser({ uid: userId, displayName: profile.displayName, pictureUrl: profile.pictureUrl });
    const name = user.displayName || profile.displayName || "LINE 用戶";

    const snap = await db().doc(`events/${eventId}`).get();
    if (!snap.exists) {
      await sayText("⚠️ 找不到這場揪團，可能已被管理員刪除");
      return;
    }
    const event = { id: snap.id, ...snap.data() };

    // 第一步：檢查後跳出確認視窗
    if (action === "join" || action === "cancel") {
      const blocker = action === "join" ? core.joinBlocker(event, userId, user) : core.cancelBlocker(event, userId);
      if (blocker) {
        await sayText(`${name}：${blocker}\n${eventLabel(event)}`);
        return;
      }
      await line.reply(ev.replyToken, confirmMessage(action, { name, uid: userId, ev: event }), token);
      return;
    }

    // 第二步：本人按下確定 → 執行並回覆結果與最新字卡
    try {
      let text;
      let result;
      if (action === "cjoin") {
        result = await core.joinEvent({ eventId, uid: userId, name });
        const pos = result.position;
        if (result.result === "already") {
          text = pos.type === "main" ? `${name} 已經報名過囉（正取第 ${pos.n} 位）` : `${name} 已經在候補名單囉（候補第 ${pos.n} 位）`;
        } else if (pos.type === "main") {
          text = `✅ ${name} 報名成功！正取第 ${pos.n} 位`;
        } else {
          text = `⏳ ${name} 已登記候補第 ${pos.n} 位，有人取消時會自動遞補`;
        }
      } else {
        result = await core.cancelEvent({ eventId, uid: userId });
        text = `👋 ${name} 已取消報名`;
        if (result.promoted) text += `\n🎉 ${result.promoted.name} 由候補遞補為正取！`;
      }
      await line.reply(ev.replyToken, [{ type: "text", text }, eventMessage(result.ev, liffId, text, iconUrl)], token);
    } catch (e) {
      if (!(e instanceof core.AppError)) console.error(e);
      await sayText(`⚠️ ${name}：${e instanceof core.AppError ? e.message : "系統忙碌，請稍後再試"}`);
    }
  }
}

function eventLabel(ev) {
  return `${ev.title || "匹克球揪團"}｜${fmtRange(ev.startAt.toMillis(), ev.endAt.toMillis())}`;
}
