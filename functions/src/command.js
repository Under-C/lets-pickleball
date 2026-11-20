// 解析 LINE 的「開團」文字指令
//
// 開團 週五夜打
// -11/26（四）19:00-22:00
// -140/人
// -提供球跟球拍
// -鼓山運動中心
// -8人滿團
//
// 規則：
//  - 第一行「開團」後面是團名（可省略，預設「匹克球揪團」）
//  - 有日期＋時間的那行 = 時間；「數字＋人/位」開頭的那行 = 人數
//  - 行首寫「地點：」「場地：」「備註：」「人數：」「時間：」會直接指定
//  - 其餘的行：最後一行 = 地點，其他 = 備註（用「、」串起來）

const TZ_OFFSET_H = 8; // 台灣 UTC+8

const FORMAT_HELP = [
  "📝 開團指令格式（每行前面加 -）：",
  "",
  "開團 週五夜打",
  "-11/26（四）19:00-22:00",
  "-140/人",
  "-提供球跟球拍",
  "-鼓山運動中心",
  "-8人滿團",
  "",
  "・第一行：開團＋團名（團名可省略）",
  "・時間：月/日 開始-結束",
  "・人數：數字＋人，例如 8人滿團",
  "・地點：放在最後一行（或寫「地點：鼓山運動中心」）",
  "・其他行都會當作備註",
].join("\n");

const stripBullet = (s) => s.replace(/^\s*[-－—–•・*＊]+\s*/, "").trim();

// 台灣時間 → UTC 毫秒
function twToMs(y, mo, d, hh, mm) {
  return Date.UTC(y, mo - 1, d, hh - TZ_OFFSET_H, mm);
}

// 解析「11/26（四）19:00-22:00」或「2026/11/26 19:00~22:00」
function parseTime(line, now = Date.now()) {
  const date = line.match(/(?:(\d{4})\s*[/／.\-年]\s*)?(\d{1,2})\s*[/／.\-月]\s*(\d{1,2})/);
  const time = line.match(/(\d{1,2})\s*[:：]\s*(\d{2})\s*[-－~～–—至到]\s*(\d{1,2})\s*[:：]\s*(\d{2})/);
  if (!date || !time) return null;
  const mo = Number(date[2]);
  const d = Number(date[3]);
  const [sh, sm, eh, em] = time.slice(1).map(Number);
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || sh > 24 || eh > 24 || sm > 59 || em > 59) return null;

  // 沒寫年份：用今年；如果日期已經過了一天以上，視為明年
  const nowTw = new Date(now + TZ_OFFSET_H * 3600e3);
  let y = date[1] ? Number(date[1]) : nowTw.getUTCFullYear();
  let start = twToMs(y, mo, d, sh, sm);
  if (!date[1] && start < now - 24 * 3600e3) {
    y += 1;
    start = twToMs(y, mo, d, sh, sm);
  }
  let end = twToMs(y, mo, d, eh, em);
  if (end <= start) end += 24 * 3600e3; // 結束比開始早 → 隔天
  // 檢查日期是否真的存在（例如 2/30）
  const chk = new Date(start + TZ_OFFSET_H * 3600e3);
  if (chk.getUTCMonth() + 1 !== mo || chk.getUTCDate() !== d) return null;
  return { startAt: start, endAt: end };
}

function parseCapacity(line) {
  const m = line.match(/^(?:人數\s*[:：]?\s*)?(\d{1,3})\s*(?:人|位)/);
  return m ? Number(m[1]) : null;
}

/**
 * 回傳 { ok: true, data } 或 { ok: false, error }
 * data: { title, startAt, endAt, location, note, capacity }
 */
function parseCreateCommand(text, now = Date.now()) {
  const lines = String(text).replace(/\r/g, "").split("\n").map((l) => l.trim()).filter(Boolean);
  const first = lines.shift() || "";
  const m = first.match(/^開團\s*(.*)$/);
  if (!m) return { ok: false, error: "指令要以「開團」開頭" };
  const title = m[1].replace(/^[\s:：]+/, "").trim().slice(0, 40) || "匹克球揪團";

  let time = null;
  let capacity = null;
  let location = "";
  const notes = [];
  const rest = [];

  for (const raw of lines) {
    const line = stripBullet(raw);
    if (!line) continue;
    const tagged = line.match(/^(地點|場地|地址|備註|說明|人數|時間|日期)\s*[:：]\s*(.+)$/);
    if (tagged) {
      const [, key, val] = tagged;
      if (key === "地點" || key === "場地" || key === "地址") location = val.trim();
      else if (key === "備註" || key === "說明") notes.push(val.trim());
      else if (key === "人數") capacity = parseCapacity(val.trim()) ?? (Number(val.replace(/\D/g, "")) || null);
      else time = parseTime(val, now);
      continue;
    }
    if (!time) {
      const t = parseTime(line, now);
      if (t) { time = t; continue; }
    }
    if (capacity == null) {
      const c = parseCapacity(line);
      if (c != null) { capacity = c; continue; }
    }
    rest.push(line);
  }

  // 沒有指定地點：剩下的最後一行當地點
  if (!location && rest.length) location = rest.pop();
  notes.unshift(...rest);

  const missing = [];
  if (!time) missing.push("時間（例如 -11/26（四）19:00-22:00）");
  if (!location) missing.push("地點（例如 -鼓山運動中心）");
  if (capacity == null) missing.push("人數（例如 -8人滿團）");
  if (missing.length) return { ok: false, error: `少了：\n・${missing.join("\n・")}` };
  if (capacity < 1 || capacity > 200) return { ok: false, error: "人數需介於 1–200" };
  if (time.startAt <= now) return { ok: false, error: "開團時間已經過了，請確認日期" };

  return {
    ok: true,
    data: {
      title,
      startAt: time.startAt,
      endAt: time.endAt,
      location: location.slice(0, 60),
      note: notes.join("、").slice(0, 200),
      capacity,
    },
  };
}

module.exports = { parseCreateCommand, parseTime, FORMAT_HELP };
