// 報名 / 取消 / 使用者 / 群組 的核心邏輯（網站和 LINE Bot 共用）
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

// ---------- 使用者 ----------

/**
 * 建立或更新使用者資料。
 * 如果系統裡還沒有任何總管理員，第一位登入的人會自動成為總管理員（role = "admin"）。
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
      createdAt: FieldValue.serverTimestamp(),
      lastSeenAt: FieldValue.serverTimestamp(),
    };
    tx.set(ref, data);
    return data;
  });
}

async function getUser(uid) {
  const snap = await db().doc(`users/${uid}`).get();
  return snap.exists ? snap.data() : null;
}

const isSuper = (user) => !!user && user.role === "admin";

// ---------- 群組 ----------

async function getGroup(gid) {
  if (!gid) return null;
  const snap = await db().doc(`groups/${gid}`).get();
  return snap.exists ? { id: snap.id, ...snap.data() } : null;
}

const inList = (list, uid) => Array.isArray(list) && list.includes(uid);
const isGroupAdmin = (group, uid, user) => isSuper(user) || (!!group && inList(group.admins, uid));
const isGroupMember = (group, uid, user) => isGroupAdmin(group, uid, user) || (!!group && inList(group.members, uid));

// Bot 被加入群組 / 聊天室時建立群組資料（已存在則只更新名稱與狀態）
async function registerGroup({ gid, type, name, pictureUrl }) {
  const ref = db().doc(`groups/${gid}`);
  await db().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const base = { type, active: true, updatedAt: FieldValue.serverTimestamp() };
    if (name) base.lineName = name;
    if (pictureUrl !== undefined) base.pictureUrl = pictureUrl || "";
    if (snap.exists) {
      tx.update(ref, base);
    } else {
      tx.set(ref, {
        ...base,
        name: name || (type === "room" ? "多人聊天室" : "LINE 群組"),
        members: [],
        admins: [],
        blocked: [],
        createdAt: FieldValue.serverTimestamp(),
      });
    }
  });
}

/**
 * 確認使用者是群組成員（不是的話加入）。
 * 先讀再寫，已經是成員就不會產生寫入。
 */
async function ensureMember(gid, uid, cachedGroup) {
  const group = cachedGroup || (await getGroup(gid));
  if (!group) return null;
  if (inList(group.members, uid)) return group;
  await db().doc(`groups/${gid}`).update({ members: FieldValue.arrayUnion(uid) });
  return { ...group, members: [...(group.members || []), uid] };
}

async function removeMember(gid, uid) {
  await db().doc(`groups/${gid}`).update({ members: FieldValue.arrayRemove(uid) }).catch(() => {});
}

// ---------- 報名 / 取消 ----------

/**
 * 報名前的檢查（Bot 跳出確認視窗前、以及真正報名時都會用到），回傳錯誤訊息或 null。
 */
function joinBlocker(ev, uid, group, user) {
  if (!group) return "這場揪團沒有所屬群組，請聯繫管理員";
  if (inList(group.blocked, uid)) return "你已被這個群組的管理員停權，無法報名";
  if (!isGroupMember(group, uid, user)) return `這場是「${group.name}」的揪團，只有該群組成員可以報名`;
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

async function joinEvent({ eventId, uid, name }) {
  const userRef = db().doc(`users/${uid}`);
  const evRef = db().doc(`events/${eventId}`);
  return db().runTransaction(async (tx) => {
    const [uSnap, eSnap] = await tx.getAll(userRef, evRef);
    if (!eSnap.exists) throw new AppError("not-found", "找不到這場揪團");
    const ev = eSnap.data();
    const gSnap = ev.groupId ? await tx.get(db().doc(`groups/${ev.groupId}`)) : null;
    const group = gSnap && gSnap.exists ? { id: gSnap.id, ...gSnap.data() } : null;
    const user = uSnap.exists ? uSnap.data() : null;

    const idx = (ev.entries || []).findIndex((e) => e.uid === uid);
    if (idx >= 0) {
      return { result: "already", position: positionOf(idx, ev.capacity), ev: { ...ev, id: eventId } };
    }
    const blocker = joinBlocker(ev, uid, group, user);
    if (blocker) throw new AppError("blocked", blocker);

    const entries = [...(ev.entries || []), { uid, name: name || "LINE 用戶", at: Date.now() }];
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
    if (!force) {
      const blocker = cancelBlocker(ev, uid);
      if (blocker) throw new AppError("locked", blocker);
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

// 某個群組（或多個群組）即將到來的揪團（含已截止報名的場次，字卡上會標示）
async function upcomingEvents(groupIds, limit = 5) {
  const ids = [].concat(groupIds).filter(Boolean).slice(0, 30);
  if (!ids.length) return [];
  let q = db().collection("events");
  q = ids.length === 1 ? q.where("groupId", "==", ids[0]) : q.where("groupId", "in", ids);
  const snap = await q.where("startAt", ">=", Timestamp.now()).orderBy("startAt").limit(limit).get();
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

// 使用者所在的所有群組
async function groupsOfUser(uid) {
  const snap = await db().collection("groups").where("members", "array-contains", uid).get();
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

module.exports = {
  AppError, DAY_MS, splitEntries, positionOf,
  upsertUser, getUser, isSuper,
  getGroup, isGroupAdmin, isGroupMember, registerGroup, ensureMember, removeMember, groupsOfUser,
  joinBlocker, cancelBlocker, joinEvent, cancelEvent, adminAddEntry, upcomingEvents,
};
