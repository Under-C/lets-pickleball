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

async function requireSuper(req) {
  const uid = requireAuth(req);
  const user = await core.getUser(uid);
  if (!core.isSuper(user)) throw new HttpsError("permission-denied", "只有總管理員可以執行這個操作");
  return { uid, user };
}

const PERM_LABEL = { admin: "群組管理員", create: "開啟揪團", manage: "揪團管理", block: "人員封鎖" };

/**
 * 需要在該群組擁有某些權限（任一即可）。perms 例如 ["admin"]、["create", "manage"]。
 * 總管理員、群組管理員自動擁有全部權限。
 */
async function requireGroupPerm(req, gid, perms) {
  const uid = requireAuth(req);
  const [user, group] = await Promise.all([core.getUser(uid), core.getGroup(gid)]);
  if (!group) throw new HttpsError("not-found", "找不到這個群組");
  const p = core.permsOf(group, uid, user);
  if (!perms.some((k) => p[k])) {
    throw new HttpsError("permission-denied", `你在這個群組沒有「${perms.map((k) => PERM_LABEL[k]).join("／")}」權限`);
  }
  return { uid, user, group, perms: p };
}

// 需要能管理某場揪團：揪團管理權限，或自己開的團（且仍有開團權限）
async function requireEventAdmin(req, eventId) {
  const uid = requireAuth(req);
  const snap = await db().doc(`events/${String(eventId)}`).get();
  if (!snap.exists) throw new HttpsError("not-found", "找不到這場揪團");
  const ev = snap.data();
  if (!ev.groupId) {
    // 沒有群組的舊資料，只有總管理員能處理
    const r = await requireSuper(req);
    return { ...r, ref: snap.ref, ev };
  }
  const [user, group] = await Promise.all([core.getUser(uid), core.getGroup(ev.groupId)]);
  if (!group || !core.canManageEvent(group, ev, uid, user)) {
    throw new HttpsError("permission-denied", "你沒有管理這場揪團的權限");
  }
  return { uid, user, group, ref: snap.ref, ev };
}

function toHttpsError(err) {
  if (err instanceof HttpsError) return err;
  if (err instanceof core.AppError) return new HttpsError("failed-precondition", err.message, { code: err.code });
  console.error(err);
  return new HttpsError("internal", "系統發生錯誤，請稍後再試");
}

function cleanStr(v, max) {
  return String(v == null ? "" : v).trim().slice(0, max);
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
  let displayName = profile.name || "";
  let pictureUrl = profile.picture || "";
  // ID Token 裡沒有名稱時，改用 Access Token 向 LINE 查詢
  if ((!displayName || !pictureUrl) && req.data.accessToken) {
    try {
      const p = await line.getProfileByAccessToken(String(req.data.accessToken), LINE_LOGIN_CHANNEL_ID.value());
      if (p.userId === uid) {
        displayName = displayName || p.displayName;
        pictureUrl = pictureUrl || p.pictureUrl;
      }
    } catch (e) {
      console.warn("getProfileByAccessToken failed", e.message);
    }
  }
  const user = await core.upsertUser({ uid, displayName, pictureUrl });
  const token = await getAuth().createCustomToken(uid);
  return { token, role: user.role };
});

// 每次打開網站時同步 LINE 名稱與頭像（使用者改了 LINE 名稱也會更新）
exports.refreshProfile = onCall(async (req) => {
  const uid = requireAuth(req);
  const accessToken = req.data && req.data.accessToken;
  if (!accessToken) throw new HttpsError("invalid-argument", "缺少 accessToken");
  let p;
  try {
    p = await line.getProfileByAccessToken(String(accessToken), LINE_LOGIN_CHANNEL_ID.value());
  } catch (e) {
    throw new HttpsError("unauthenticated", e.message);
  }
  if (p.userId !== uid) throw new HttpsError("permission-denied", "LINE 帳號不符");
  await core.upsertUser({ uid, displayName: p.displayName, pictureUrl: p.pictureUrl });
  return { displayName: p.displayName };
});

// 從群組字卡點進網站時，把使用者加入該群組
exports.linkGroup = onCall(async (req) => {
  const uid = requireAuth(req);
  const gid = cleanStr(req.data.groupId, 80);
  const group = await core.getGroup(gid);
  if (!group || !group.active) throw new HttpsError("not-found", "找不到這個群組");
  await core.ensureMember(gid, uid, group);
  return { name: group.name };
});

// ---------- 一般用戶：報名 / 取消 ----------
exports.joinEvent = onCall(async (req) => {
  const uid = requireAuth(req);
  try {
    const user = await core.getUser(uid);
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

// ---------- 群組管理員：揪團 ----------
exports.adminSaveEvent = onCall(async (req) => {
  const d = req.data || {};
  const startAt = Number(d.startAt);
  const endAt = Number(d.endAt);
  const capacity = Number(d.capacity);
  const groupId = cleanStr(d.groupId, 80);
  const data = {
    title: cleanStr(d.title, 40) || "匹克球揪團",
    location: cleanStr(d.location, 60),
    courts: cleanStr(d.courts, 120),
    note: cleanStr(d.note, 200),
    capacity,
    cancelLock24h: !!d.cancelLock24h,
    status: d.status === "closed" ? "closed" : "open",
  };
  if (!groupId) throw new HttpsError("invalid-argument", "請選擇群組");
  if (!data.location) throw new HttpsError("invalid-argument", "請填寫地點");
  if (!Number.isFinite(startAt) || !Number.isFinite(endAt) || endAt <= startAt) {
    throw new HttpsError("invalid-argument", "開始 / 結束時間不正確");
  }
  if (!Number.isInteger(capacity) || capacity < 1 || capacity > 200) {
    throw new HttpsError("invalid-argument", "人數上限需為 1–200 的整數");
  }
  // 新增：目標群組要有開團權限；編輯並換群組：目標群組要有開團或揪團管理權限
  const { uid } = await requireGroupPerm(req, groupId, d.id ? ["create", "manage"] : ["create"]);
  data.groupId = groupId;
  data.startAt = Timestamp.fromMillis(startAt);
  data.endAt = Timestamp.fromMillis(endAt);
  data.updatedAt = FieldValue.serverTimestamp();

  if (d.id) {
    // 編輯時也要能管理這場揪團
    const { ref } = await requireEventAdmin(req, d.id);
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
  const { ref } = await requireEventAdmin(req, req.data.eventId);
  await ref.delete();
  return { ok: true };
});

exports.adminSetEventStatus = onCall(async (req) => {
  const { ref } = await requireEventAdmin(req, req.data.eventId);
  const status = req.data.status === "closed" ? "closed" : "open";
  await ref.update({ status, updatedAt: FieldValue.serverTimestamp() });
  return { status };
});

exports.adminAddEntry = onCall(async (req) => {
  const { uid } = await requireEventAdmin(req, req.data.eventId);
  const name = cleanStr(req.data.name, 30);
  if (!name) throw new HttpsError("invalid-argument", "請輸入名字");
  try {
    const r = await core.adminAddEntry({ eventId: String(req.data.eventId), name, by: uid });
    return { position: r.position };
  } catch (e) {
    throw toHttpsError(e);
  }
});

exports.adminRemoveEntry = onCall(async (req) => {
  await requireEventAdmin(req, req.data.eventId);
  try {
    const r = await core.cancelEvent({ eventId: String(req.data.eventId), uid: String(req.data.uid), force: true });
    return { promoted: r.promoted ? r.promoted.name : null };
  } catch (e) {
    throw toHttpsError(e);
  }
});

// ---------- 群組管理員：成員 ----------

// 列出群組成員（含名稱、頭像、權限、是否封鎖）：群組管理員或有人員封鎖權限的人可看
exports.adminListGroupMembers = onCall(async (req) => {
  const { group } = await requireGroupPerm(req, cleanStr(req.data.groupId, 80), ["admin", "block"]);
  const ids = [...new Set([
    ...(group.members || []), ...(group.admins || []), ...(group.blocked || []),
    ...(group.canCreate || []), ...(group.canManage || []), ...(group.canBlock || []),
  ])];
  const refs = ids.map((id) => db().doc(`users/${id}`));
  const snaps = refs.length ? await db().getAll(...refs) : [];
  const members = snaps.map((s, i) => {
    const u = s.exists ? s.data() : {};
    return {
      uid: ids[i],
      name: u.displayName || "（尚未登入過的用戶）",
      pictureUrl: u.pictureUrl || "",
      isGroupAdmin: (group.admins || []).includes(ids[i]),
      isSuper: u.role === "admin",
      canCreate: (group.canCreate || []).includes(ids[i]),
      canManage: (group.canManage || []).includes(ids[i]),
      canBlock: (group.canBlock || []).includes(ids[i]),
      blocked: (group.blocked || []).includes(ids[i]),
      inGroup: (group.members || []).includes(ids[i]),
    };
  });
  return { members };
});

/**
 * 設定群組成員：
 *  blocked                          需要「人員封鎖」權限（不能封鎖總管理員、群組管理員）
 *  isGroupAdmin / canCreate / canManage / canBlock   需要是群組管理員
 */
exports.adminSetGroupMember = onCall(async (req) => {
  const gid = cleanStr(req.data.groupId, 80);
  const d = req.data || {};
  const wantsPerm = ["isGroupAdmin", "canCreate", "canManage", "canBlock"].some((k) => d[k] !== undefined);
  const { uid: me, group } = await requireGroupPerm(req, gid, wantsPerm ? ["admin"] : ["block"]);
  const target = cleanStr(d.uid, 80);
  if (!target) throw new HttpsError("invalid-argument", "缺少使用者");
  if (target === me) throw new HttpsError("failed-precondition", "不能變更自己的權限或封鎖自己");
  const targetUser = await core.getUser(target);
  if (core.isSuper(targetUser)) throw new HttpsError("failed-precondition", "不能變更總管理員");

  const ref = db().doc(`groups/${gid}`);
  const patch = {};
  const toggle = (field, on) => { patch[field] = on ? FieldValue.arrayUnion(target) : FieldValue.arrayRemove(target); };
  if (d.blocked !== undefined) {
    if (d.blocked && (group.admins || []).includes(target)) throw new HttpsError("failed-precondition", "不能封鎖群組管理員");
    toggle("blocked", !!d.blocked);
  }
  if (d.isGroupAdmin !== undefined) toggle("admins", !!d.isGroupAdmin);
  if (d.canCreate !== undefined) toggle("canCreate", !!d.canCreate);
  if (d.canManage !== undefined) toggle("canManage", !!d.canManage);
  if (d.canBlock !== undefined) toggle("canBlock", !!d.canBlock);
  // 給了任何權限的人一定是群組成員
  if (wantsPerm && [d.isGroupAdmin, d.canCreate, d.canManage, d.canBlock].some((v) => v === true)) {
    patch.members = FieldValue.arrayUnion(target);
  }
  await ref.update(patch);
  return { ok: true };
});

// 改群組顯示名稱（群組管理員）
exports.adminRenameGroup = onCall(async (req) => {
  await requireGroupPerm(req, cleanStr(req.data.groupId, 80), ["admin"]);
  const gid = cleanStr(req.data.groupId, 80);
  const name = cleanStr(req.data.name, 30);
  if (!name) throw new HttpsError("invalid-argument", "請輸入群組名稱");
  const ref = db().doc(`groups/${gid}`);
  if (!(await ref.get()).exists) throw new HttpsError("not-found", "找不到這個群組");
  await ref.update({ name });
  return { ok: true };
});

// 刪除 Bot 已離開的群組，連同該群組的揪團（只有總管理員）
exports.adminDeleteGroup = onCall(async (req) => {
  await requireSuper(req);
  const gid = cleanStr(req.data.groupId, 80);
  const ref = db().doc(`groups/${gid}`);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError("not-found", "找不到這個群組");
  if (snap.data().active !== false) throw new HttpsError("failed-precondition", "Bot 還在這個群組裡，請先把 Bot 移出群組再刪除");
  const evs = await db().collection("events").where("groupId", "==", gid).get();
  const writer = db().bulkWriter();
  evs.docs.forEach((d) => writer.delete(d.ref));
  writer.delete(ref);
  await writer.close();
  return { deletedEvents: evs.size };
});

// ---------- 總管理員 ----------
exports.adminSetUser = onCall(async (req) => {
  const { uid: me } = await requireSuper(req);
  const target = String(req.data.uid || "");
  if (!target) throw new HttpsError("invalid-argument", "缺少使用者");
  if (target === me) throw new HttpsError("failed-precondition", "不能變更自己的權限");
  const ref = db().doc(`users/${target}`);
  if (!(await ref.get()).exists) throw new HttpsError("not-found", "找不到這位使用者");
  if (req.data.role !== undefined) await ref.update({ role: req.data.role === "admin" ? "admin" : "user" });
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
      events.map((ev) => handleLineEvent(ev).catch((e) => console.error("handleLineEvent error", e)))
    );
    res.status(200).send("ok");
  }
);

// 群組 / 多人聊天室的 ID（一對一聊天為 null）
function chatGroupId(source) {
  if (!source) return null;
  if (source.type === "group") return source.groupId;
  if (source.type === "room") return source.roomId;
  return null;
}

async function handleLineEvent(ev) {
  const token = LINE_CHANNEL_ACCESS_TOKEN.value();
  const liffId = LIFF_ID.value();
  const iconUrl = `${SITE_URL.value().replace(/\/$/, "")}/pickleball.png`;
  const gid = chatGroupId(ev.source);
  const userId = ev.source && ev.source.userId;
  const sayText = (t) => line.reply(ev.replyToken, { type: "text", text: t }, token);

  // Bot 被加入群組 / 聊天室
  if (ev.type === "join" && gid) {
    const summary = ev.source.type === "group" ? await line.getGroupSummary(gid, token) : { name: "", pictureUrl: "" };
    await core.registerGroup({ gid, type: ev.source.type, name: summary.name, pictureUrl: summary.pictureUrl });
    await sayText("大家好！我是打球啦 🎉\n在群組輸入「揪團」就能查看近期場次並報名。\n輸入「教學」可以看使用說明。");
    return;
  }
  // Bot 離開群組
  if (ev.type === "leave" && gid) {
    await db().doc(`groups/${gid}`).update({ active: false }).catch(() => {});
    return;
  }
  // 有人加入 / 離開群組
  if (ev.type === "memberJoined" && gid) {
    for (const m of (ev.joined && ev.joined.members) || []) {
      if (m.userId) await core.ensureMember(gid, m.userId);
    }
    return;
  }
  if (ev.type === "memberLeft" && gid) {
    for (const m of (ev.left && ev.left.members) || []) {
      if (m.userId) await core.removeMember(gid, m.userId);
    }
    return;
  }

  // 在群組裡發言或按按鈕的人，記錄為群組成員（Bot 加入前就存在的群組也會自動建立）
  let group = null;
  if (gid && userId) {
    group = await core.getGroup(gid);
    if (!group) {
      const summary = ev.source.type === "group" ? await line.getGroupSummary(gid, token) : { name: "", pictureUrl: "" };
      await core.registerGroup({ gid, type: ev.source.type, name: summary.name, pictureUrl: summary.pictureUrl });
      group = await core.getGroup(gid);
    }
    group = await core.ensureMember(gid, userId, group);
  }

  if (ev.type === "message" && ev.message.type === "text") {
    const msg = ev.message.text.trim();
    if (LIST_KEYWORDS.includes(msg)) {
      let list;
      if (gid) {
        list = await core.upcomingEvents(gid, 5);
      } else if (userId) {
        // 一對一聊天：顯示使用者所在所有群組的揪團，並標示群組名稱
        const groups = await core.groupsOfUser(userId);
        const names = Object.fromEntries(groups.map((g) => [g.id, g.name]));
        list = (await core.upcomingEvents(groups.map((g) => g.id), 5)).map((e) => ({ ...e, groupName: names[e.groupId] }));
      } else {
        list = [];
      }
      if (!list.length) {
        await sayText(gid ? "這個群組目前沒有即將到來的揪團喔！" : "你所在的群組目前沒有即將到來的揪團喔！");
      } else {
        await line.reply(ev.replyToken, eventsCarousel(list, liffId, iconUrl), token);
      }
    } else if (HELP_KEYWORDS.includes(msg)) {
      const g = gid ? `&g=${encodeURIComponent(gid)}` : "";
      await sayText(`📖 使用教學\nhttps://liff.line.me/${liffId}?view=help${g}\n\n在群組輸入「揪團」即可查看近期場次並報名。`);
    }
    return;
  }

  if (ev.type === "postback") {
    const params = new URLSearchParams(ev.postback.data);
    const action = params.get("a");
    const eventId = params.get("e");
    // 「先不要 / 按錯了」：不需要回覆
    if (!eventId || !["join", "cancel", "cjoin", "ccancel"].includes(action)) return;

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
    const eventGroup = event.groupId === (group && group.id) ? group : await core.getGroup(event.groupId);

    // 第一步：檢查後跳出確認視窗
    if (action === "join" || action === "cancel") {
      const blocker = action === "join" ? core.joinBlocker(event, userId, eventGroup, user) : core.cancelBlocker(event, userId);
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
