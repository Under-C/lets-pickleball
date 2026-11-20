import { firebaseConfig, LIFF_ID, REGION } from "./config.js";
import { initializeApp } from "https://www.gstatic.com/firebasejs/12.18.0/firebase-app.js";
import { getAuth, onAuthStateChanged, signInWithCustomToken, signOut } from "https://www.gstatic.com/firebasejs/12.18.0/firebase-auth.js";
import {
  getFirestore, collection, doc, query, where, orderBy, limit, onSnapshot, Timestamp,
} from "https://www.gstatic.com/firebasejs/12.18.0/firebase-firestore.js";
import { getFunctions, httpsCallable } from "https://www.gstatic.com/firebasejs/12.18.0/firebase-functions.js";

const fbApp = initializeApp(firebaseConfig);
const auth = getAuth(fbApp);
const db = getFirestore(fbApp);
const fns = getFunctions(fbApp, REGION);
const call = (name, data) => httpsCallable(fns, name)(data).then((r) => r.data);

const DAY = 24 * 60 * 60 * 1000;
const WD = ["日", "一", "二", "三", "四", "五", "六"];
const VIEWS = ["home", "calendar", "my", "help", "admin"];

const S = {
  loggedIn: false,
  uid: null,
  me: null,
  events: [],
  users: [],
  view: "home",
  shellKey: "",
  calMonth: startOfMonth(new Date()),
  calSel: dayKey(Date.now()),
  adminTab: "events",
  openEntries: new Set(),
  userQ: "",
  usersUnsub: null,
  groups: [],            // 看得到的群組
  selGroup: (() => { try { return localStorage.getItem("selGroup") || ""; } catch { return ""; } })(), // 目前選擇的群組
  dataMode: "",          // super = 讀全部；member = 只讀自己的群組
  unsubs: [],            // 資料監聽（切換模式時取消）
  eventsByGroup: {},     // 一般成員：每個群組各自的揪團
  eventUnsubs: {},
  memberGroup: "",       // 群組成員管理：目前選的群組
  showInactive: false,   // 群組成員管理：是否顯示 Bot 已離開的群組
  groupMembers: {},      // gid -> 成員清單
};

const $app = document.getElementById("app");
const $nav = document.getElementById("nav");
const $me = document.getElementById("me");

// 原創吉祥物：拿著球拍的笑臉匹克球
const MASCOT = `<svg viewBox="0 0 120 120" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
  <g transform="translate(98 36) rotate(28)">
    <rect x="-4.5" y="10" width="9" height="24" rx="4" fill="#F2B705" stroke="#C99400" stroke-width="2"/>
    <rect x="-14" y="-27" width="28" height="37" rx="11" fill="#2F5D8C" stroke="#1F4268" stroke-width="3"/>
    <rect x="-9" y="-22" width="7" height="15" rx="3.5" fill="#fff" opacity=".28"/>
  </g>
  <path d="M84 66 Q94 60 96 52" stroke="#8FB02E" stroke-width="6" fill="none" stroke-linecap="round"/>
  <circle cx="52" cy="66" r="40" fill="#C9E84F" stroke="#8FB02E" stroke-width="3"/>
  <g fill="#A9C93C">
    <circle cx="34" cy="38" r="4"/><circle cx="54" cy="32" r="4"/><circle cx="72" cy="42" r="4"/>
    <circle cx="22" cy="58" r="3.5"/><circle cx="84" cy="78" r="3.5"/><circle cx="30" cy="92" r="4"/>
    <circle cx="52" cy="98" r="4"/><circle cx="72" cy="94" r="3.5"/>
  </g>
  <ellipse cx="41" cy="62" rx="4.5" ry="5.5" fill="#2B2B2B"/><ellipse cx="63" cy="62" rx="4.5" ry="5.5" fill="#2B2B2B"/>
  <circle cx="42.5" cy="60" r="1.6" fill="#fff"/><circle cx="64.5" cy="60" r="1.6" fill="#fff"/>
  <ellipse cx="32" cy="74" rx="6" ry="3.5" fill="#FF8FA3" opacity=".6"/><ellipse cx="72" cy="74" rx="6" ry="3.5" fill="#FF8FA3" opacity=".6"/>
  <path d="M42 74 Q52 84 62 74" stroke="#2B2B2B" stroke-width="3" fill="none" stroke-linecap="round"/>
</svg>`;
document.querySelector(".brand").innerHTML = `${MASCOT}<span>打球啦</span>`;

// ---------- 小工具 ----------
function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function pad(n) { return String(n).padStart(2, "0"); }
function dayKey(ms) { const d = new Date(ms); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
function startOfMonth(d) { return new Date(d.getFullYear(), d.getMonth(), 1); }
function fmtDate(ms) { const d = new Date(ms); return `${d.getMonth() + 1}/${d.getDate()}（${WD[d.getDay()]}）`; }
function fmtTime(ms) { const d = new Date(ms); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; }
function fmtRange(s, e) {
  return dayKey(s) === dayKey(e) ? `${fmtDate(s)} ${fmtTime(s)}–${fmtTime(e)}` : `${fmtDate(s)} ${fmtTime(s)}–${fmtDate(e)} ${fmtTime(e)}`;
}
function split(ev) { const en = ev.entries || []; return { main: en.slice(0, ev.capacity), wait: en.slice(ev.capacity) }; }
function myPos(ev) {
  const i = (ev.entries || []).findIndex((e) => e.uid === S.uid);
  if (i < 0) return null;
  return i < ev.capacity ? { type: "main", n: i + 1 } : { type: "wait", n: i - ev.capacity + 1 };
}
function statusText(m, w, cap) {
  if (m < cap) return `還缺 ${cap - m} 人，快來揪！`;
  if (w > 0) return `額滿囉，候補 ${w} 人排隊中`;
  return "額滿囉！剛剛好一場";
}
const isSuper = () => S.me?.role === "admin";
// 我在某群組的權限（群組管理員 = 全部權限）
function permsIn(g) {
  if (!g) return { admin: isSuper(), create: isSuper(), manage: isSuper(), block: isSuper() };
  const admin = isSuper() || (g.admins || []).includes(S.uid);
  const has = (f) => admin || (g[f] || []).includes(S.uid);
  return { admin, create: has("canCreate"), manage: has("canManage"), block: has("canBlock") };
}
const anyPerm = (p) => p.admin || p.create || p.manage || p.block;
const active = (list) => list.filter((g) => g.active !== false); // Bot 還在的群組
const groupsWith = (fn) => S.groups.filter((g) => fn(permsIn(g)));
const adminGroupsAll = () => groupsWith(anyPerm);                           // 有任何管理權限的群組
const adminGroups = () => active(adminGroupsAll());
const eventGroupsAll = () => groupsWith((p) => p.create || p.manage);      // 可以處理揪團的群組
const memberGroupsAll = () => groupsWith((p) => p.admin || p.block);       // 可以管成員的群組
// 能不能管理某場揪團：揪團管理權限，或自己開的團
function canManageEv(ev) {
  if (!ev.groupId) return isSuper();
  const p = permsIn(findGroup(ev.groupId));
  return p.manage || (p.create && ev.createdBy === S.uid);
}
const activeGroups = () => S.groups.filter((g) => g.active !== false);
const isAdmin = () => isSuper() || adminGroups().length > 0; // 可以進入管理頁
const findGroup = (gid) => S.groups.find((g) => g.id === gid);
const groupName = (gid) => findGroup(gid)?.name || "（未分組）";
const isBlockedIn = (gid) => (findGroup(gid)?.blocked || []).includes(S.uid);
// 只有一個群組時顯示全部；多個群組時依 Header 選單篩選
const visibleEvents = () => (S.selGroup === "all" || activeGroups().length < 2 ? S.events : S.events.filter((e) => e.groupId === S.selGroup));
const sortGroups = (list) => list.sort((a, b) => (a.name || "").localeCompare(b.name || "", "zh-Hant"));

let toastTimer;
function toast(msg) {
  const t = document.getElementById("toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), 2800);
}

// ---------- 導覽 ----------
function getView() {
  const v = new URLSearchParams(location.search).get("view");
  return VIEWS.includes(v) ? v : "home";
}
function go(v) {
  const url = new URL(location.href);
  url.searchParams.set("view", v);
  if (!S.loggedIn && v !== "help") {
    liff.login({ redirectUri: url.toString() });
    return;
  }
  S.view = v;
  history.replaceState(null, "", url);
  render();
  window.scrollTo(0, 0);
}
$nav.addEventListener("click", (e) => {
  const a = e.target.closest("a[data-view]");
  if (a) go(a.dataset.view);
});

// ---------- 登入 ----------
async function main() {
  try {
    await liff.init({ liffId: LIFF_ID });
  } catch (e) {
    $app.innerHTML = `<div class="empty">LIFF 初始化失敗：${esc(e.message)}<br>請確認 config.js 的 LIFF_ID 是否正確</div>`;
    return;
  }
  S.view = getView();
  $nav.classList.remove("hidden");

  // 沒登入（通常是用一般瀏覽器開啟）：顯示歡迎頁，由使用者自己按登入
  if (!liff.isLoggedIn()) {
    render();
    return;
  }

  try {
    await firebaseLogin();
  } catch (e) {
    if (e?.message === "redirecting") return;
    $app.innerHTML = `<div class="empty">登入失敗：${esc(e.message)}</div>`;
    return;
  }
  S.loggedIn = true;
  S.uid = auth.currentUser.uid;
  // 背景同步 LINE 名稱與頭像（不影響畫面載入）
  call("refreshProfile", { accessToken: liff.getAccessToken() }).catch((e) => console.warn("refreshProfile", e.message));

  // 從群組字卡點進來（網址帶 g=群組ID）：加入該群組並預設選它
  const url = new URL(location.href);
  const linkG = url.searchParams.get("g");
  if (linkG) {
    try { await call("linkGroup", { groupId: linkG }); S.selGroup = linkG; try { localStorage.setItem("selGroup", linkG); } catch {} } catch {}
    url.searchParams.delete("g");
    history.replaceState(null, "", url);
  }

  onSnapshot(doc(db, "users", S.uid), (snap) => {
    S.me = snap.data() || null;
    setupData();
    renderMe();
    render();
  });

  render();
}

const toEvent = (d) => {
  const x = d.data();
  return { id: d.id, ...x, start: x.startAt.toMillis(), end: x.endAt.toMillis() };
};
const sinceTs = () => Timestamp.fromMillis(Date.now() - 120 * DAY);

// 依身分載入資料：總管理員讀全部；一般成員只讀自己所在群組
function setupData() {
  const mode = isSuper() ? "super" : "member";
  if (S.dataMode === mode) return;
  S.dataMode = mode;
  S.unsubs.forEach((u) => u());
  S.unsubs = [];
  Object.values(S.eventUnsubs).forEach((u) => u());
  S.eventUnsubs = {};
  S.eventsByGroup = {};
  S.events = [];
  const onErr = (err) => toast(`讀取資料失敗：${err.message}`);

  if (mode === "super") {
    S.unsubs.push(onSnapshot(collection(db, "groups"), (snap) => {
      S.groups = sortGroups(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
      S.groupsLoaded = true;
      renderMe();
      render();
    }, onErr));
    S.unsubs.push(onSnapshot(
      query(collection(db, "events"), where("startAt", ">=", sinceTs()), orderBy("startAt"), limit(1000)),
      (snap) => { S.events = snap.docs.map(toEvent); render(); }, onErr));
    S.unsubs.push(onSnapshot(collection(db, "users"), (snap) => {
      S.users = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      render();
    }, onErr));
    return;
  }

  // 一般成員 / 群組管理員
  S.unsubs.push(onSnapshot(
    query(collection(db, "groups"), where("members", "array-contains", S.uid)),
    (snap) => {
      S.groups = sortGroups(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
      S.groupsLoaded = true;
      const ids = new Set(S.groups.map((g) => g.id));
      // 新群組 → 開始監聽它的揪團；離開的群組 → 停止
      for (const gid of ids) {
        if (S.eventUnsubs[gid]) continue;
        S.eventUnsubs[gid] = onSnapshot(
          query(collection(db, "events"), where("groupId", "==", gid), where("startAt", ">=", sinceTs()), orderBy("startAt"), limit(300)),
          (s) => { S.eventsByGroup[gid] = s.docs.map(toEvent); mergeEvents(); },
          onErr);
      }
      for (const gid of Object.keys(S.eventUnsubs)) {
        if (!ids.has(gid)) { S.eventUnsubs[gid](); delete S.eventUnsubs[gid]; delete S.eventsByGroup[gid]; }
      }
      if (S.selGroup && S.selGroup !== "all" && !ids.has(S.selGroup)) S.selGroup = "";
      mergeEvents();
      renderMe();
    }, onErr));
}

function mergeEvents() {
  S.events = Object.values(S.eventsByGroup).flat().sort((a, b) => a.start - b.start);
  render();
}

async function firebaseLogin() {
  const sub = liff.getDecodedIDToken()?.sub;
  const current = await new Promise((res) => {
    const un = onAuthStateChanged(auth, (u) => { un(); res(u); });
  });
  if (current && current.uid === sub) return;
  if (current) await signOut(auth);

  try {
    const { token } = await call("lineLogin", { idToken: liff.getIDToken(), accessToken: liff.getAccessToken() });
    await signInWithCustomToken(auth, token);
    try { sessionStorage.removeItem("relogin"); } catch {}
  } catch (e) {
    // LIFF 的 ID Token 過期時，重新登入一次
    let tried = false;
    try { tried = sessionStorage.getItem("relogin") === "1"; sessionStorage.setItem("relogin", "1"); } catch {}
    if (e.code === "functions/unauthenticated" && !tried) {
      liff.logout();
      liff.login({ redirectUri: location.href });
      throw new Error("redirecting");
    }
    throw e;
  }
}

function renderMe() {
  if (!S.me) { $me.innerHTML = ""; return; }
  const badges = isSuper() ? `<span class="badge">總管理員</span>`
    : groupsWith((p) => p.admin).length ? `<span class="badge">群組管理員</span>`
    : isAdmin() ? `<span class="badge">管理權限</span>` : "";
  $me.innerHTML = `${badges}<span>${esc(S.me.displayName)}</span>${S.me.pictureUrl ? `<img src="${esc(S.me.pictureUrl)}" alt="">` : ""}`;
  document.querySelector(".admin-only").classList.toggle("hidden", !isAdmin());
}

// ---------- 畫面 ----------
function render() {
  if (S.view === "admin" && S.loggedIn && S.me && S.groupsLoaded && !isAdmin()) S.view = "home";
  document.querySelectorAll("#nav a").forEach((a) => a.classList.toggle("active", a.dataset.view === S.view));
  renderGroupSel();

  // 沒登入時，除了教學頁以外都顯示歡迎頁
  const view = !S.loggedIn && S.view !== "help" ? "landing" : S.view;
  const key = view === "admin" ? `admin:${S.adminTab}` : view;
  if (S.shellKey !== key) {
    S.shellKey = key;
    SHELL[view]();
  }
  UPDATE[view]?.();
}

// Google 日曆新增活動連結（時間用 UTC，Google 會依使用者時區顯示）
function gcalUrl(ev) {
  const t = (ms) => new Date(ms).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const details = [
    ev.courts ? `場地：${ev.courts}` : "",
    ev.note ? `備註：${ev.note}` : "",
    ev.groupId ? `群組：${groupName(ev.groupId)}` : "",
    `報名狀態與名單：https://liff.line.me/${LIFF_ID}`,
  ].filter(Boolean).join("\n");
  const p = new URLSearchParams({
    action: "TEMPLATE",
    text: `🏓 ${ev.title || "匹克球揪團"}`,
    dates: `${t(ev.start)}/${t(ev.end)}`,
    location: ev.location || "",
    details,
  });
  return `https://calendar.google.com/calendar/render?${p.toString()}`;
}

// 群組切換列（只有一個群組時不顯示）
function groupBar(list = activeGroups()) {
  if (list.length < 2) return "";
  const chip = (gid, label) => `<button class="small chip ${S.selGroup === gid ? "active" : ""}" data-act="selGroup" data-gid="${esc(gid)}">${esc(label)}</button>`;
  return `<div class="chips">${chip("all", "全部群組")}${list.map((g) => chip(g.id, g.name)).join("")}</div>`;
}
// （舊的群組切換列已改成 Header 的下拉選單）
function fillGroupBar() {}

// Header 的群組選單：在兩個以上群組時顯示；行事曆固定顯示全部群組，所以隱藏
const $groupSel = document.getElementById("groupSel");
function renderGroupSel() {
  const groups = activeGroups();
  // 預設選第一個群組（網址帶的群組、上次選的群組優先）
  if (groups.length && S.selGroup !== "all" && !groups.some((g) => g.id === S.selGroup)) S.selGroup = groups[0].id;
  const show = S.loggedIn && groups.length >= 2 && !["calendar", "help"].includes(S.view);
  $groupSel.classList.toggle("hidden", !show);
  if (!show) return;
  const opts = groups.map((g) => `<option value="${esc(g.id)}">${esc(g.name)}</option>`).join("")
    + `<option value="all">全部群組</option>`;
  if ($groupSel.dataset.opts !== opts) { $groupSel.innerHTML = opts; $groupSel.dataset.opts = opts; }
  $groupSel.value = S.selGroup;
}
$groupSel.addEventListener("change", () => {
  S.selGroup = $groupSel.value;
  try { localStorage.setItem("selGroup", S.selGroup); } catch {}
  render();
});

function eventCard(ev) {
  const { main, wait } = split(ev);
  const pos = myPos(ev);
  const now = Date.now();
  const canJoin = !pos && ev.status === "open" && ev.start > now && !isBlockedIn(ev.groupId);
  const canCancel = !!pos && ev.start > now;
  const maxDots = 24;
  const dots = Array.from({ length: Math.min(ev.capacity, maxDots) }, (_, i) => `<span class="dot ${i < main.length ? "on" : ""}"></span>`).join("")
    + (ev.capacity > maxDots ? `<span class="muted">+${ev.capacity - maxDots}</span>` : "");
  const mine = pos
    ? `<span class="mine ${pos.type === "wait" ? "wait" : ""}">${pos.type === "main" ? `✅ 你是正取第 ${pos.n} 位` : `⏳ 你在候補第 ${pos.n} 位`}</span>`
    : "";
  const tag = ev.status !== "open" ? `<span class="badge">🔒 已截止報名</span>` : ev.start <= now ? `<span class="badge">已開始</span>` : "";

  return `
  <div class="card">
    <div class="card-head">
      <div class="head-row"><span class="ttl"><img class="pb-ico" src="pickleball.svg" alt="">${esc(ev.title || "匹克球揪團")}</span>${tag}</div>
      <div class="card-group">👥 ${esc(groupName(ev.groupId))}</div>
    </div>
    <div class="card-body">
      <div class="loc">📍 ${esc(ev.location)}</div>
      <div>📅 ${fmtRange(ev.start, ev.end)}</div>
      ${ev.courts ? `<div>🏟️ 場地：${esc(ev.courts)}</div>` : ""}
      <div class="dots">${dots}</div>
      <div class="count">👥 ${main.length}/${ev.capacity}<small>候補 ${wait.length}</small></div>
      <div class="status">${statusText(main.length, wait.length, ev.capacity)}</div>
      ${main.length ? `<div class="names">正取：${main.map((e) => esc(e.name)).join("、")}</div>` : ""}
      ${wait.length ? `<div class="names wait">候補：${wait.map((e) => esc(e.name)).join("、")}</div>` : ""}
      ${ev.note ? `<div>📝 ${esc(ev.note)}</div>` : ""}
      ${ev.cancelLock24h ? `<div class="muted">⏰ 開打前 24 小時內不可取消正取</div>` : ""}
      ${mine ? `<div>${mine}</div>` : ""}
    </div>
    <div class="card-foot">
      <button data-act="cancel" data-id="${ev.id}" ${canCancel ? "" : "disabled"}>取消 -1</button>
      <button class="primary" data-act="join" data-id="${ev.id}" ${canJoin ? "" : "disabled"}>報名 +1</button>
      ${pos && ev.end > now ? `<button class="gcal" data-act="gcal" data-id="${ev.id}">📅 加入 Google 日曆</button>` : ""}
    </div>
  </div>`;
}

const SHELL = {
  landing() {
    $app.innerHTML = `
    <div class="landing">
      <div class="landing-hero">
        ${MASCOT}
        <h1>匹克球揪團</h1>
        <p class="muted">一起打球吧！看看最近有哪些場次可以報名</p>
      </div>
      <div class="panel">
        <b>🔒 這是社團內部頁面</b>
        <p class="muted">場次、場地與名單需要用 LINE 登入後才會顯示。</p>
        <button class="primary" style="width:100%" data-act="login">用 LINE 登入</button>
      </div>
      <div class="panel">
        <b>👥 怎麼報名？</b>
        <p>點場次卡片的「報名 +1」就完成！<br>一人一位，朋友想來請他自己按。<br>額滿會自動排候補，有人取消就遞補你。</p>
        <button class="small" data-act="goHelp">看完整教學 →</button>
      </div>
      <p class="muted" style="text-align:center">尚未登入</p>
    </div>`;
  },
  home() {
    $app.innerHTML = `<h2>近期揪團</h2><div id="groupBar"></div><div id="blockedNote"></div><div id="list" class="cards"></div>`;
  },
  calendar() {
    $app.innerHTML = `
      <div class="cal-head">
        <button class="small" data-act="calPrev">‹ 上個月</button>
        <h2 id="calTitle" style="margin:0"></h2>
        <button class="small" data-act="calNext">下個月 ›</button>
      </div>
      <div id="groupBar"></div>
      <p class="muted cal-legend">顯示你所有群組的揪團　<i class="lg reg"></i> 你已報名　<i class="lg"></i> 其他場次</p>
      <div id="calGrid" class="cal-grid"></div>
      <h3 id="calDayTitle"></h3>
      <div id="calList" class="cards"></div>`;
  },
  my() {
    $app.innerHTML = `<h2>我的報名</h2><div id="groupBar"></div><div id="myUp" class="cards"></div><h3>過去的揪團</h3><div id="myPast" class="list"></div>`;
  },
  help() {
    $app.innerHTML = `
    <div class="help">
      <h2>📖 使用教學</h2>
      <div class="panel">
        <b>在 LINE 群組報名</b>
        <ol>
          <li>在群組輸入「<b>揪團</b>」，會出現最近 5 場的揪團字卡</li>
          <li>左右滑動找到想打的那一場</li>
          <li>按「<b>報名 +1</b>」或「<b>取消 -1</b>」，Bot 會跳出確認視窗</li>
          <li>由<b>你本人</b>按「確定報名／確定取消」才會生效，別人按無效（一人一位，幫朋友報名請他自己按）</li>
          <li>完成後 Bot 會回覆結果和這場最新的字卡</li>
        </ol>
      </div>
      <div class="panel">
        <b>👥 群組</b>
        <p>每個 LINE 群組的揪團分開管理，你只會看到自己所在群組的場次。</p>
        <p>在群組裡發言、按字卡，或從群組字卡點進網站，就會自動加入該群組。</p>
      </div>
      <div class="panel">
        <b>🔒 已截止報名</b>
        <p>管理員關閉報名的場次，一般用戶無法自行報名，需要請管理員幫忙加入名單。</p>
      </div>
      <div class="panel">
        <b>正取與候補</b>
        <p>每場有人數上限，依報名先後排序。額滿後報名的人會列入<b>候補</b>。</p>
        <p>正取有人取消時，<b>候補第一位會自動遞補為正取</b>，不需要再操作。</p>
      </div>
      <div class="panel">
        <b>取消規則</b>
        <p>有標示「⏰ 開打前 24 小時內不可取消正取」的場次，開打前 24 小時內無法自行取消正取，請聯繫管理員。</p>
        <p>候補的人隨時都可以取消。</p>
      </div>
      <div class="panel">
        <b>網站功能</b>
        <p><img class="pb-ico" src="pickleball.svg" alt="">揪團：查看並報名近期場次</p>
        <p>📅 行事曆：用月曆查看所有場次</p>
        <p>🙋 我的：查看自己報名的場次與正取／候補狀態</p>
      </div>
      ${S.loggedIn ? "" : `<button class="primary" style="width:100%" data-act="login">用 LINE 登入</button>`}
    </div>`;
  },
  admin() {
    // 沒有對應權限的分頁自動切到可用的分頁
    if (S.adminTab === "events" && !eventGroupsAll().length && memberGroupsAll().length) S.adminTab = "members";
    if (S.adminTab === "members" && !memberGroupsAll().length && eventGroupsAll().length) S.adminTab = "events";
    if (S.adminTab === "users" && !isSuper()) S.adminTab = "events";
    S.shellKey = `admin:${S.adminTab}`;
    const tab = S.adminTab;
    $app.innerHTML = `
      <div class="tabs">
        ${eventGroupsAll().length ? `<button data-act="tab" data-tab="events" class="${tab === "events" ? "active" : ""}">揪團管理</button>` : ""}
        ${memberGroupsAll().length ? `<button data-act="tab" data-tab="members" class="${tab === "members" ? "active" : ""}">群組成員</button>` : ""}
        ${isSuper() ? `<button data-act="tab" data-tab="users" class="${tab === "users" ? "active" : ""}">總管理員</button>` : ""}
      </div>
      ${tab === "events"
        ? `<div id="groupBar"></div>
           ${groupsWith((p) => p.create).length ? `<button class="primary" style="width:100%;margin-bottom:12px" data-act="newEvent">＋ 新增揪團</button>` : ""}
           <div id="formBox"></div>
           <h3>即將到來</h3><div id="upList" class="list"></div>
           <h3>已結束（近 120 天）</h3><div id="pastList" class="list"></div>`
        : tab === "members"
        ? `<div class="panel form">
             <label>選擇群組<select id="memberGroup"></select></label>
             <label class="check" id="inactiveToggle"><input type="checkbox" id="showInactive" ${S.showInactive ? "checked" : ""}> 顯示 Bot 已離開的群組</label>
             <div id="groupInfo"></div>
           </div>
           <input id="memberQ" placeholder="搜尋成員名稱…" value="${esc(S.userQ)}" style="margin-bottom:12px">
           <div id="memberList" class="list"></div>`
        : `<p class="muted">總管理員可以管理所有群組、指定群組管理員。</p>
           <input id="userQ" placeholder="搜尋名稱…" value="${esc(S.userQ)}" style="margin-bottom:12px">
           <div id="userList" class="list"></div>`}`;
    for (const id of ["userQ", "memberQ"]) {
      const q = document.getElementById(id);
      if (q) q.addEventListener("input", () => { S.userQ = q.value; UPDATE.admin(); });
    }
    const sel = document.getElementById("memberGroup");
    if (sel) sel.addEventListener("change", () => { S.memberGroup = sel.value; loadMembers(true); });
    const chk = document.getElementById("showInactive");
    if (chk) chk.addEventListener("change", () => { S.showInactive = chk.checked; S.memberGroup = ""; UPDATE.admin(); });
  },
};

const UPDATE = {
  home() {
    const now = Date.now();
    fillGroupBar();
    const list = visibleEvents().filter((e) => e.start > now);
    const blockedIn = S.groups.filter((g) => (g.blocked || []).includes(S.uid)).map((g) => g.name);
    document.getElementById("blockedNote").innerHTML = blockedIn.length
      ? `<div class="panel" style="color:var(--red)">你已被「${esc(blockedIn.join("、"))}」的管理員停權，暫時無法在該群組報名。</div>` : "";
    let empty = `${MASCOT}目前沒有即將到來的揪團<br><span class="muted">敲敲主揪，或等下一場開團吧！</span>`;
    if (S.me && !S.groups.length) {
      empty = `${MASCOT}你還沒有加入任何群組<br><span class="muted">在有「打球啦」的 LINE 群組裡輸入「揪團」，<br>或從群組的揪團字卡點進來，就會出現該群組的場次。</span>`;
    }
    document.getElementById("list").innerHTML = list.length ? list.map(eventCard).join("") : `<div class="empty">${empty}</div>`;
  },
  calendar() {
    const m = S.calMonth;
    document.getElementById("calTitle").textContent = `${m.getFullYear()} 年 ${m.getMonth() + 1} 月`;
    // 行事曆固定顯示所有群組的揪團，避免報名日期衝突
    const byDay = {};
    for (const e of S.events) (byDay[dayKey(e.start)] ||= []).push(e);
    const isMine = (e) => (e.entries || []).some((x) => x.uid === S.uid);

    const first = new Date(m.getFullYear(), m.getMonth(), 1);
    const startDate = new Date(first);
    startDate.setDate(1 - first.getDay());
    const today = dayKey(Date.now());
    let html = WD.map((w) => `<div class="cal-wd">${w}</div>`).join("");
    for (let i = 0; i < 42; i++) {
      const d = new Date(startDate);
      d.setDate(startDate.getDate() + i);
      const k = dayKey(d.getTime());
      const dayEvents = byDay[k] || [];
      const marks = dayEvents.slice(0, 3).map((e) => `<i class="${isMine(e) ? "reg" : ""}"></i>`).join("");
      const cls = ["cal-day", d.getMonth() !== m.getMonth() ? "other" : "", k === today ? "today" : "", k === S.calSel ? "sel" : "",
        dayEvents.some(isMine) ? "has-mine" : ""].join(" ");
      html += `<div class="${cls}" data-act="calDay" data-day="${k}">${d.getDate()}<div class="marks">${marks}</div></div>`;
    }
    document.getElementById("calGrid").innerHTML = html;

    const [y, mo, da] = S.calSel.split("-").map(Number);
    const sel = new Date(y, mo - 1, da);
    document.getElementById("calDayTitle").textContent = `${mo}/${da}（${WD[sel.getDay()]}）的揪團`;
    const list = byDay[S.calSel] || [];
    // 同一天你報名的揪團時間重疊時提醒
    const mine = list.filter(isMine);
    const clash = mine.some((a, i) => mine.some((b, j) => i < j && a.start < b.end && b.start < a.end));
    const warn = clash ? `<div class="panel" style="color:var(--red)">⚠️ 這天你報名的揪團時間有重疊，請確認是否都能參加。</div>` : "";
    document.getElementById("calList").innerHTML = warn + (list.length ? list.map(eventCard).join("") : `<div class="empty">這天沒有揪團</div>`);
  },
  my() {
    const now = Date.now();
    fillGroupBar();
    const mine = visibleEvents().filter((e) => (e.entries || []).some((x) => x.uid === S.uid));
    const up = mine.filter((e) => e.end > now);
    const past = mine.filter((e) => e.end <= now).reverse();
    document.getElementById("myUp").innerHTML = up.length ? up.map(eventCard).join("") : `<div class="empty">${MASCOT}還沒有報名任何揪團</div>`;
    document.getElementById("myPast").innerHTML = past.length
      ? past.map((e) => {
          const p = myPos(e);
          return `<div class="item"><div class="top"><b>${esc(e.title || "匹克球揪團")}</b><span class="muted">${p?.type === "main" ? "正取" : "候補"}</span></div><div class="muted">${fmtRange(e.start, e.end)}｜${esc(e.location)}</div></div>`;
        }).join("")
      : `<div class="empty">沒有紀錄</div>`;
  },
  help() {},
  admin() {
    if (!isAdmin()) return;
    if (S.adminTab === "events") updateAdminEvents();
    else if (S.adminTab === "members") updateAdminMembers();
    else if (isSuper()) updateAdminUsers();
  },
};

// ---------- 管理後台：揪團 ----------
function updateAdminEvents() {
  const now = Date.now();
  const mine = active(eventGroupsAll());
  fillGroupBar(mine);
  const manageable = visibleEvents().filter(canManageEv);
  const up = manageable.filter((e) => e.end > now);
  const past = manageable.filter((e) => e.end <= now).reverse();
  const item = (e) => {
    const { main, wait } = split(e);
    const open = S.openEntries.has(e.id);
    const entries = (e.entries || []).map((x, i) => `
      <div class="entry"><span>${i < e.capacity ? `正取 ${i + 1}` : `候補 ${i - e.capacity + 1}`}｜${esc(x.name)}${x.manual ? ` <span class="muted">（管理員新增）</span>` : ""}</span>
      <button class="small danger" data-act="removeEntry" data-id="${e.id}" data-uid="${esc(x.uid)}" data-name="${esc(x.name)}">刪除</button></div>`).join("");
    const isOpen = e.status === "open";
    return `
    <div class="item">
      ${mine.length > 1 || !e.groupId ? `<div class="muted">👥 ${esc(groupName(e.groupId))}</div>` : ""}
      <div class="top"><b>${esc(e.title || "匹克球揪團")}</b>${isOpen ? `<span class="badge" style="background:#e3f0e5;color:var(--green)">報名中</span>` : `<span class="badge red">🔒 已截止</span>`}</div>
      <div class="muted">${fmtRange(e.start, e.end)}｜${esc(e.location)}${e.createdBy === S.uid ? "｜你開的團" : ""}</div>
      <div>👥 正取 ${main.length}/${e.capacity}，候補 ${wait.length}${e.cancelLock24h ? "　⏰24h" : ""}</div>
      <div class="acts">
        <button class="small" data-act="editEvent" data-id="${e.id}">編輯</button>
        ${permsIn(findGroup(e.groupId)).create ? `<button class="small" data-act="copyEvent" data-id="${e.id}">複製</button>` : ""}
        <button class="small" data-act="toggleEntries" data-id="${e.id}">${open ? "收起名單" : `名單 (${(e.entries || []).length})`}</button>
        <button class="small ${isOpen ? "" : "primary"}" data-act="toggleStatus" data-id="${e.id}">${isOpen ? "🔒 關閉報名" : "🔓 開放報名"}</button>
        <button class="small danger" data-act="deleteEvent" data-id="${e.id}">刪除揪團</button>
      </div>
      ${open ? `<div>
        ${entries || `<div class="muted">還沒有人報名</div>`}
        <div style="display:flex;gap:6px;margin-top:8px">
          <input id="add-${e.id}" maxlength="30" placeholder="輸入名字新增報名者">
          <button class="small primary" data-act="addEntry" data-id="${e.id}" style="white-space:nowrap">＋ 新增</button>
        </div>
      </div>` : ""}
    </div>`;
  };
  // 重新整理列表時，保留正在輸入的名字與游標
  const typed = {};
  document.querySelectorAll("input[id^='add-']").forEach((i) => { if (i.value) typed[i.id] = i.value; });
  const focusId = document.activeElement?.id;

  document.getElementById("upList").innerHTML = up.length ? up.map(item).join("") : `<div class="empty">沒有即將到來的揪團</div>`;
  document.getElementById("pastList").innerHTML = past.length ? past.map(item).join("") : `<div class="empty">沒有紀錄</div>`;

  for (const [k, v] of Object.entries(typed)) { const i = document.getElementById(k); if (i) i.value = v; }
  if (focusId?.startsWith("add-")) document.getElementById(focusId)?.focus();
}

async function addEntry(eventId, btn) {
  const input = document.getElementById(`add-${eventId}`);
  const name = input.value.trim();
  if (!name) { toast("請輸入名字"); return; }
  if (btn) btn.disabled = true;
  try {
    const r = await call("adminAddEntry", { eventId, name });
    input.value = "";
    toast(r.position.type === "main" ? `已新增「${name}」，正取第 ${r.position.n} 位` : `已新增「${name}」，候補第 ${r.position.n} 位`);
  } catch (err) {
    toast(`⚠️ ${err.message}`);
  } finally {
    if (btn) btn.disabled = false;
  }
}

$app.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && e.target.id?.startsWith("add-")) {
    e.preventDefault();
    addEntry(e.target.id.slice(4));
  }
});

function openForm(ev, { copy = false } = {}) {
  const box = document.getElementById("formBox");
  const base = ev || {};
  let start = base.start ?? (() => { const d = new Date(); d.setDate(d.getDate() + 1); d.setHours(19, 0, 0, 0); return d.getTime(); })();
  let end = base.end ?? start + 2 * 60 * 60 * 1000;
  if (copy) { start += 7 * DAY; end += 7 * DAY; }
  const id = copy ? "" : base.id || "";
  // 新增 / 複製：需要開團權限的群組；編輯：可開團或可管理的群組
  const groups = active(id ? eventGroupsAll() : groupsWith((p) => p.create));
  if (!groups.length) { toast("你沒有可以開團的群組"); return; }
  const defGroup = base.groupId || (S.selGroup !== "all" ? S.selGroup : groups[0].id);
  box.innerHTML = `
  <form id="evForm" class="panel form">
    <b>${id ? "編輯揪團" : copy ? "複製揪團（預設下週同一時間）" : "新增揪團"}</b>
    <input type="hidden" name="id" value="${esc(id)}">
    <label>群組 *<select name="groupId" required>
      ${groups.map((g) => `<option value="${esc(g.id)}" ${g.id === defGroup ? "selected" : ""}>${esc(g.name)}</option>`).join("")}
    </select></label>
    <label>標題（不填則為「匹克球揪團」）<input name="title" maxlength="40" value="${esc(base.title || "")}" placeholder="匹克球揪團"></label>
    <label>地點 *<input name="location" maxlength="60" required value="${esc(base.location || "")}" placeholder="鼓山運動中心"></label>
    <label>場地<input name="courts" maxlength="120" value="${esc(base.courts || "")}" placeholder="場02 18-19、場03 19-20"></label>
    <div class="row">
      <label>日期 *<input type="date" name="date" required value="${dayKey(start)}"></label>
      <label>開始 *<input type="time" name="st" required value="${fmtTime(start)}"></label>
      <label>結束 *<input type="time" name="et" required value="${fmtTime(end)}"></label>
    </div>
    <label>人數上限 *<input type="number" name="capacity" min="1" max="200" required value="${base.capacity || 8}"></label>
    <label>備註<input name="note" maxlength="200" value="${esc(base.note || "")}" placeholder="新手友善"></label>
    <label class="check"><input type="checkbox" name="cancelLock24h" ${base.cancelLock24h === false ? "" : "checked"}> 開打前 24 小時內不可取消正取</label>
    <label>狀態<select name="status">
      <option value="open" ${base.status !== "closed" ? "selected" : ""}>開放報名</option>
      <option value="closed" ${base.status === "closed" ? "selected" : ""}>關閉報名</option>
    </select></label>
    <div class="card-foot" style="padding:0">
      <button type="button" data-act="closeForm">取消</button>
      <button type="submit" class="primary">儲存</button>
    </div>
  </form>`;
  box.scrollIntoView({ behavior: "smooth" });
  document.getElementById("evForm").addEventListener("submit", saveForm);
}

async function saveForm(e) {
  e.preventDefault();
  const f = new FormData(e.target);
  const startAt = new Date(`${f.get("date")}T${f.get("st")}`).getTime();
  let endAt = new Date(`${f.get("date")}T${f.get("et")}`).getTime();
  if (endAt <= startAt) endAt += DAY; // 結束時間早於開始 → 視為隔天
  const btn = e.target.querySelector("button[type=submit]");
  btn.disabled = true;
  try {
    await call("adminSaveEvent", {
      id: f.get("id") || null,
      groupId: f.get("groupId"),
      title: f.get("title"),
      location: f.get("location"),
      courts: f.get("courts"),
      note: f.get("note"),
      capacity: Number(f.get("capacity")),
      cancelLock24h: f.get("cancelLock24h") === "on",
      status: f.get("status"),
      startAt,
      endAt,
    });
    toast("已儲存 ✅");
    document.getElementById("formBox").innerHTML = "";
  } catch (err) {
    toast(`儲存失敗：${err.message}`);
    btn.disabled = false;
  }
}

// ---------- 管理後台：用戶 ----------
function updateAdminUsers() {
  const q = S.userQ.trim().toLowerCase();
  const list = S.users
    .filter((u) => !q || (u.displayName || "").toLowerCase().includes(q))
    .sort((a, b) => (b.role === "admin") - (a.role === "admin") || (a.displayName || "").localeCompare(b.displayName || "", "zh-Hant"));
  document.getElementById("userList").innerHTML = list.length ? list.map((u) => {
    const self = u.id === S.uid;
    const seen = u.lastSeenAt?.toMillis ? `最近使用 ${fmtDate(u.lastSeenAt.toMillis())}` : "";
    return `
    <div class="item">
      <div class="user">
        ${u.pictureUrl ? `<img src="${esc(u.pictureUrl)}" alt="">` : `<div class="ph"></div>`}
        <div class="info"><b>${esc(u.displayName)}${self ? "（你）" : ""}</b><span class="muted">${seen}</span></div>
        ${u.role === "admin" ? `<span class="badge">總管理員</span>` : ""}
      </div>
      ${self ? "" : `<div class="acts">
        <select data-act="setRole" data-uid="${esc(u.id)}" style="width:auto">
          <option value="user" ${u.role !== "admin" ? "selected" : ""}>一般用戶</option>
          <option value="admin" ${u.role === "admin" ? "selected" : ""}>總管理員</option>
        </select>
      </div>`}
    </div>`;
  }).join("") : `<div class="empty">沒有符合的用戶</div>`;
}

// ---------- 管理後台：群組成員 ----------
async function loadMembers(force = false) {
  const gid = S.memberGroup;
  if (!gid || (S.groupMembers[gid] && !force)) { UPDATE.admin(); return; }
  if (!S.groupMembers[gid]) S.groupMembers[gid] = null; // 讀取中
  UPDATE.admin();
  try {
    const r = await call("adminListGroupMembers", { groupId: gid });
    S.groupMembers[gid] = r.members;
  } catch (err) {
    toast(`⚠️ ${err.message}`);
    S.groupMembers[gid] = [];
  }
  UPDATE.admin();
}

function updateAdminMembers() {
  const all = memberGroupsAll();
  const inactiveCount = all.filter((g) => g.active === false).length;
  const groups = S.showInactive ? all : active(all);
  const sel = document.getElementById("memberGroup");
  const toggle = document.getElementById("inactiveToggle");
  toggle.classList.toggle("hidden", !inactiveCount);
  toggle.lastChild.textContent = ` 顯示 Bot 已離開的群組（${inactiveCount}）`;
  if (!groups.length) {
    sel.innerHTML = "";
    document.getElementById("groupInfo").innerHTML = "";
    document.getElementById("groupInfo").dataset.gid = "";
    document.getElementById("memberList").innerHTML = `<div class="empty">還沒有可以管理的群組<br><span class="muted">把「打球啦」邀請進 LINE 群組後就會出現在這裡</span></div>`;
    return;
  }
  if (!S.memberGroup || !groups.some((g) => g.id === S.memberGroup)) S.memberGroup = groups[0].id;
  const opts = groups.map((g) => `<option value="${esc(g.id)}" ${g.id === S.memberGroup ? "selected" : ""}>${esc(g.name)}${g.active === false ? "（Bot 已離開）" : ""}</option>`).join("");
  if (sel.innerHTML !== opts) sel.innerHTML = opts;

  const g = findGroup(S.memberGroup);
  const my = permsIn(g);
  const info = document.getElementById("groupInfo");
  const infoHtml = my.admin
    ? `<div style="display:flex;gap:6px"><input id="groupNameInput" maxlength="30" value="${esc(g?.name || "")}" placeholder="群組顯示名稱"><button type="button" class="small primary" data-act="renameGroup" style="white-space:nowrap">改名</button></div>
       <p class="muted">LINE 群組名稱：${esc(g?.lineName || "（無）")}｜成員 ${(g?.members || []).length} 人</p>
       ${g?.active === false && isSuper() ? `<p class="muted">Bot 已離開這個群組。重新把 Bot 加回同一個群組會自動恢復；不需要的話可以刪除。</p>
       <button type="button" class="small danger" data-act="deleteGroup">刪除這個群組（含所有揪團）</button>` : ""}`
    : `<p class="muted">成員 ${(g?.members || []).length} 人</p>`;
  if (info.dataset.gid !== S.memberGroup || !document.getElementById("groupNameInput") && my.admin) {
    info.innerHTML = infoHtml;
    info.dataset.gid = S.memberGroup;
  }

  const list = S.groupMembers[S.memberGroup];
  const box = document.getElementById("memberList");
  if (list === undefined) { loadMembers(); return; }
  if (list === null) { box.innerHTML = `<div class="loading">讀取成員中…</div>`; return; }
  const q = S.userQ.trim().toLowerCase();
  const rows = list
    .filter((m) => !q || m.name.toLowerCase().includes(q))
    .sort((a, b) => (b.isSuper - a.isSuper) || (b.isGroupAdmin - a.isGroupAdmin)
      || ((b.canCreate || b.canManage || b.canBlock) - (a.canCreate || a.canManage || a.canBlock))
      || (a.blocked - b.blocked) || a.name.localeCompare(b.name, "zh-Hant"));
  box.innerHTML = rows.length ? rows.map((m) => {
    const self = m.uid === S.uid;
    return `
    <div class="item">
      <div class="user">
        ${m.pictureUrl ? `<img src="${esc(m.pictureUrl)}" alt="">` : `<div class="ph"></div>`}
        <div class="info"><b>${esc(m.name)}${self ? "（你）" : ""}</b>${m.inGroup ? "" : `<span class="muted">已不在群組</span>`}</div>
        ${m.isSuper ? `<span class="badge">總管理員</span>` : m.isGroupAdmin ? `<span class="badge">群組管理員</span>` : ""}
        ${m.blocked ? `<span class="badge red">已封鎖</span>` : ""}
      </div>
      ${!m.isSuper && !m.isGroupAdmin && (m.canCreate || m.canManage || m.canBlock)
        ? `<div class="perm-tags">${m.canCreate ? "<span>開啟揪團</span>" : ""}${m.canManage ? "<span>揪團管理</span>" : ""}${m.canBlock ? "<span>人員封鎖</span>" : ""}</div>` : ""}
      ${self || m.isSuper ? "" : `<div class="acts">
        ${my.admin ? `
          <button class="small ${m.isGroupAdmin ? "" : "primary"}" data-act="setPerm" data-perm="isGroupAdmin" data-uid="${esc(m.uid)}" data-on="${m.isGroupAdmin ? 1 : 0}" data-name="${esc(m.name)}">${m.isGroupAdmin ? "取消群組管理員" : "設為群組管理員"}</button>
          ${m.isGroupAdmin ? "" : [["canCreate", "開啟揪團"], ["canManage", "揪團管理"], ["canBlock", "人員封鎖"]].map(([k, label]) =>
            `<button class="small perm ${m[k] ? "on" : ""}" data-act="setPerm" data-perm="${k}" data-uid="${esc(m.uid)}" data-on="${m[k] ? 1 : 0}" data-name="${esc(m.name)}">${m[k] ? "✓ " : "＋ "}${label}</button>`).join("")}` : ""}
        ${my.block && !m.isGroupAdmin ? `<button class="small ${m.blocked ? "" : "danger"}" data-act="toggleGroupBlock" data-uid="${esc(m.uid)}" data-on="${m.blocked ? 1 : 0}" data-name="${esc(m.name)}">${m.blocked ? "解除封鎖" : "封鎖"}</button>` : ""}
      </div>`}
    </div>`;
  }).join("") : `<div class="empty">還沒有成員<br><span class="muted">成員在群組裡發言或按字卡後就會出現</span></div>`;
}

// ---------- 按鈕事件 ----------
$app.addEventListener("click", async (e) => {
  const el = e.target.closest("[data-act]");
  if (!el || el.tagName === "SELECT") return;
  const act = el.dataset.act;
  const id = el.dataset.id;
  const ev = S.events.find((x) => x.id === id);

  const busy = async (fn) => {
    el.disabled = true;
    try { await fn(); } catch (err) { toast(`⚠️ ${err.message}`); } finally { el.disabled = false; }
  };

  switch (act) {
    case "login": {
      const url = new URL(location.href);
      if (url.searchParams.get("view") === "help") url.searchParams.delete("view");
      liff.login({ redirectUri: url.toString() });
      break;
    }
    case "goHelp": go("help"); break;
    case "join":
      if (!confirm(`確定要報名「${ev?.title || "匹克球揪團"}」${ev ? `\n${ev.location} ${fmtRange(ev.start, ev.end)}` : ""}？（一人一位）`)) return;
      await busy(async () => {
        const r = await call("joinEvent", { eventId: id });
        if (r.result === "already") toast("你已經報名過了");
        else toast(r.position.type === "main" ? `✅ 報名成功！正取第 ${r.position.n} 位` : `⏳ 已登記候補第 ${r.position.n} 位`);
      });
      break;
    case "cancel": {
      const pos = ev && myPos(ev);
      if (!confirm(`確定要取消「${ev?.title || "匹克球揪團"}」${pos?.type === "wait" ? "的候補" : ""}嗎？`)) return;
      await busy(async () => {
        const r = await call("cancelEvent", { eventId: id });
        toast(r.promoted ? `已取消，${r.promoted} 由候補遞補 🎉` : "已取消報名");
      });
      break;
    }
    case "calPrev": S.calMonth = new Date(S.calMonth.getFullYear(), S.calMonth.getMonth() - 1, 1); UPDATE.calendar(); break;
    case "calNext": S.calMonth = new Date(S.calMonth.getFullYear(), S.calMonth.getMonth() + 1, 1); UPDATE.calendar(); break;
    case "calDay": S.calSel = el.dataset.day; UPDATE.calendar(); break;
    case "tab": S.adminTab = el.dataset.tab; render(); break;
    case "newEvent": openForm(null); break;
    case "editEvent": openForm(ev); break;
    case "copyEvent": openForm(ev, { copy: true }); break;
    case "closeForm": document.getElementById("formBox").innerHTML = ""; break;
    case "toggleEntries":
      S.openEntries.has(id) ? S.openEntries.delete(id) : S.openEntries.add(id);
      updateAdminEvents();
      break;
    case "deleteEvent":
      if (!confirm(`確定刪除「${ev?.title || "匹克球揪團"}」${ev ? fmtRange(ev.start, ev.end) : ""}？報名名單會一起刪除。`)) return;
      await busy(async () => { await call("adminDeleteEvent", { eventId: id }); toast("已刪除"); });
      break;
    case "addEntry": await addEntry(id, el); break;
    case "toggleStatus": {
      const next = ev?.status === "open" ? "closed" : "open";
      if (next === "closed" && !confirm("關閉報名後，一般用戶無法自行報名，只有管理員可以新增人員。確定關閉嗎？")) return;
      await busy(async () => {
        await call("adminSetEventStatus", { eventId: id, status: next });
        toast(next === "closed" ? "🔒 已關閉報名" : "🔓 已開放報名");
      });
      break;
    }
    case "removeEntry":
      if (!confirm(`確定把「${el.dataset.name}」從名單移除？`)) return;
      await busy(async () => {
        const r = await call("adminRemoveEntry", { eventId: id, uid: el.dataset.uid });
        toast(r.promoted ? `已移除，${r.promoted} 遞補為正取` : "已移除");
      });
      break;
    case "selGroup": S.selGroup = el.dataset.gid; render(); break;
    case "gcal": {
      if (!ev) return;
      const url = gcalUrl(ev);
      // 在 LINE 裡用外部瀏覽器開啟，手機有 Google 日曆 App 時會直接跳過去
      if (liff.isInClient()) liff.openWindow({ url, external: true });
      else window.open(url, "_blank", "noopener");
      break;
    }
    case "toggleGroupBlock": {
      const blocked = el.dataset.on !== "1";
      if (blocked && !confirm(`封鎖後「${el.dataset.name}」將無法在「${groupName(S.memberGroup)}」報名，確定嗎？`)) return;
      await busy(async () => {
        await call("adminSetGroupMember", { groupId: S.memberGroup, uid: el.dataset.uid, blocked });
        toast(blocked ? "已封鎖" : "已解除封鎖");
        await loadMembers(true);
      });
      break;
    }
    case "setPerm": {
      const on = el.dataset.on !== "1";
      const perm = el.dataset.perm;
      const label = { isGroupAdmin: "群組管理員", canCreate: "開啟揪團", canManage: "揪團管理", canBlock: "人員封鎖" }[perm];
      if (perm === "isGroupAdmin" && on && !confirm(`把「${el.dataset.name}」設為群組管理員？\n群組管理員擁有這個群組的全部權限，也能指派其他人。`)) return;
      await busy(async () => {
        await call("adminSetGroupMember", { groupId: S.memberGroup, uid: el.dataset.uid, [perm]: on });
        toast(on ? `已給予「${label}」權限` : `已移除「${label}」權限`);
        await loadMembers(true);
      });
      break;
    }
    case "deleteGroup": {
      const g = findGroup(S.memberGroup);
      const n = S.events.filter((e) => e.groupId === S.memberGroup).length;
      if (!confirm(`確定刪除「${g?.name}」？\n這個群組的揪團（近期 ${n} 場與更早的紀錄）會一起刪除，無法復原。`)) return;
      await busy(async () => {
        const r = await call("adminDeleteGroup", { groupId: S.memberGroup });
        toast(`已刪除群組與 ${r.deletedEvents} 場揪團`);
        delete S.groupMembers[S.memberGroup];
        S.memberGroup = "";
      });
      break;
    }
    case "renameGroup": {
      const name = document.getElementById("groupNameInput").value.trim();
      await busy(async () => { await call("adminRenameGroup", { groupId: S.memberGroup, name }); toast("已更新群組名稱"); });
      break;
    }
  }
});

$app.addEventListener("change", async (e) => {
  const el = e.target;
  if (el.dataset.act !== "setRole") return;
  el.disabled = true;
  try {
    await call("adminSetUser", { uid: el.dataset.uid, role: el.value });
    toast(el.value === "admin" ? "已設為管理員" : "已改為一般用戶");
  } catch (err) {
    toast(`⚠️ ${err.message}`);
    updateAdminUsers();
  } finally {
    el.disabled = false;
  }
});

main();
