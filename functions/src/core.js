// 報名 / 取消 / 使用者 的核心邏輯（網站和 LINE Bot 共用）
const { getFirestore, FieldValue, Timestamp } = require("firebase-admin/firestore");

const DAY_MS = 24 * 60 * 60 * 1000;

class AppError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const db = () => getFirestore();

// 依照順序：前 capacity 位是正取，其餘是候補
function splitEntries(ev) {
  const entries = ev.entries || [];
  return { main: entries.slice(0, ev.capacity), wait: entries.slice(ev.capacity) };
}

function positionOf(index, capacity) {
  return index < capacity ? { type: "main", n: index + 1 } : { type: "wait", n: index - capacity + 1 };
}

/**
 * 建立或更新使用者資料。
 * 如果系統裡還沒有任何管理員，第一位登入的人會自動成為管理員。
 */
async function upsertUser({ uid, displayName, pictureUrl }) {
  const ref = db().doc(`users/${uid}`);
  return db().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (snap.exists) {
      const patch = { lastSeenAt: FieldValue.serverTimestamp() };
      if (displayName) patch.displayName = displayName;
      if (pictureUrl !== undefined) patch.pictureUrl = pictureUrl || "";
      tx.update(ref, patch);
      return { ...snap.data(), ...patch };
    }
    const admins = await tx.get(db().collection("users").where("role", "==", "admin").limit(1));
    const data = {
      displayName: displayName || "LINE 用戶",
      pictureUrl: pictureUrl || "",
      role: admins.empty ? "admin" : "user",
      blocked: false,
      createdAt: FieldValue.serverTimestamp(),
      lastSeenAt: FieldValue.serverTimestamp(),
    };
    tx.set(ref, data);
    return data;
  });
}

async function joinEvent({ eventId, uid, name }) {
  const userRef = db().doc(`users/${uid}`);
  const evRef = db().doc(`events/${eventId}`);
  return db().runTransaction(async (tx) => {
    const [uSnap, eSnap] = await tx.getAll(userRef, evRef);
    if (uSnap.exists && uSnap.data().blocked) {
      throw new AppError("blocked", "你的帳號已被管理員停權，無法報名");
    }
    if (!eSnap.exists) throw new AppError("not-found", "找不到這場揪團");
    const ev = eSnap.data();
    if (ev.status !== "open") throw new AppError("closed", "這場已關閉報名");
    if (ev.startAt.toMillis() <= Date.now()) throw new AppError("closed", "這場已經開始，無法報名");

    const entries = [...(ev.entries || [])];
    const idx = entries.findIndex((e) => e.uid === uid);
    if (idx >= 0) {
      return { result: "already", position: positionOf(idx, ev.capacity), ev: { ...ev, id: eventId } };
    }
    entries.push({ uid, name: name || "LINE 用戶", at: Date.now() });
    tx.update(evRef, {
      entries,
      memberIds: FieldValue.arrayUnion(uid),
      updatedAt: FieldValue.serverTimestamp(),
    });
    return {
      result: "joined",
      position: positionOf(entries.length - 1, ev.capacity),
      ev: { ...ev, id: eventId, entries },
    };
  });
}

/**
 * 管理員手動新增報名者（只需名字，佔一個名額）。
 * 不受「關閉報名」與開始時間限制。
 */
async function adminAddEntry({ eventId, name, by }) {
  const evRef = db().doc(`events/${eventId}`);
  return db().runTransaction(async (tx) => {
    const eSnap = await tx.get(evRef);
    if (!eSnap.exists) throw new AppError("not-found", "找不到這場揪團");
    const ev = eSnap.data();
    const entries = [...(ev.entries || [])];
    const uid = `manual_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
    entries.push({ uid, name, at: Date.now(), manual: true, addedBy: by });
    tx.update(evRef, { entries, updatedAt: FieldValue.serverTimestamp() });
    return { position: positionOf(entries.length - 1, ev.capacity), ev: { ...ev, id: eventId, entries } };
  });
}

/**
 * 報名前的檢查（給 Bot 跳出確認視窗前使用），回傳錯誤訊息或 null。
 */
function joinBlocker(ev, uid, user) {
  if (user && user.blocked) return "你的帳號已被管理員停權，無法報名";
  if (ev.status !== "open") return "🔒 這場已截止報名，如需報名請聯繫管理員";
  if (ev.startAt.toMillis() <= Date.now()) return "這場已經開始，無法報名";
  const idx = (ev.entries || []).findIndex((e) => e.uid === uid);
  if (idx >= 0) {
    const p = positionOf(idx, ev.capacity);
    return p.type === "main" ? `你已經報名過囉（正取第 ${p.n} 位）` : `你已經在候補名單囉（候補第 ${p.n} 位）`;
  }
  return null;
}

function cancelBlocker(ev, uid) {
  const idx = (ev.entries || []).findIndex((e) => e.uid === uid);
  if (idx < 0) return "你沒有報名這場喔";
  const startMs = ev.startAt.toMillis();
  if (startMs <= Date.now()) return "這場已經開始，無法取消";
  if (idx < ev.capacity && ev.cancelLock24h && startMs - Date.now() < DAY_MS) {
    return "開打前 24 小時內無法取消正取，請聯繫管理員";
  }
  return null;
}

/**
 * 取消報名。force = true 時（管理員移除）不檢查 24 小時限制與開始時間。
 * 正取取消後，候補第一位會自動遞補。
 */
async function cancelEvent({ eventId, uid, force = false }) {
  const evRef = db().doc(`events/${eventId}`);
  return db().runTransaction(async (tx) => {
    const eSnap = await tx.get(evRef);
    if (!eSnap.exists) throw new AppError("not-found", "找不到這場揪團");
    const ev = eSnap.data();
    const entries = [...(ev.entries || [])];
    const idx = entries.findIndex((e) => e.uid === uid);
    if (idx < 0) throw new AppError("not-registered", "你沒有報名這場喔");

    const wasMain = idx < ev.capacity;
    const startMs = ev.startAt.toMillis();
    if (!force) {
      if (startMs <= Date.now()) throw new AppError("closed", "這場已經開始，無法取消");
      if (wasMain && ev.cancelLock24h && startMs - Date.now() < DAY_MS) {
        throw new AppError("locked", "開打前 24 小時內無法取消正取，請聯繫管理員");
      }
    }

    const [removed] = entries.splice(idx, 1);
    // 正取有人退出，原本候補第一位（現在排在 capacity-1 的位置）遞補
    const promoted = wasMain && entries.length >= ev.capacity ? entries[ev.capacity - 1] : null;
    tx.update(evRef, {
      entries,
      memberIds: FieldValue.arrayRemove(uid),
      updatedAt: FieldValue.serverTimestamp(),
    });
    return { result: "cancelled", removed, promoted, wasMain, ev: { ...ev, id: eventId, entries } };
  });
}

// 取得即將到來的揪團（含已截止報名的場次，字卡上會標示）
async function upcomingEvents(limit = 5) {
  const snap = await db()
    .collection("events")
    .where("startAt", ">=", Timestamp.now())
    .orderBy("startAt")
    .limit(limit)
    .get();
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

module.exports = {
  AppError, splitEntries, positionOf, upsertUser, joinEvent, cancelEvent, adminAddEntry,
  joinBlocker, cancelBlocker, upcomingEvents, DAY_MS,
};
