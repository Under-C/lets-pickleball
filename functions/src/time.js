// 時間格式化（固定台灣時區）
const TZ = "Asia/Taipei";
const WD = { Sun: "日", Mon: "一", Tue: "二", Wed: "三", Thu: "四", Fri: "五", Sat: "六" };

const fmt = new Intl.DateTimeFormat("en-US", {
  timeZone: TZ,
  year: "numeric",
  month: "numeric",
  day: "numeric",
  weekday: "short",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

function parts(ms) {
  const p = {};
  for (const x of fmt.formatToParts(new Date(ms))) p[x.type] = x.value;
  return p;
}

// 11/19（四）
function fmtDate(ms) {
  const p = parts(ms);
  return `${p.month}/${p.day}（${WD[p.weekday]}）`;
}

// 18:00
function fmtTime(ms) {
  const p = parts(ms);
  return `${p.hour}:${p.minute}`;
}

// 11/19（四）18:00–20:00
function fmtRange(startMs, endMs) {
  const sameDay = fmtDate(startMs) === fmtDate(endMs);
  return sameDay
    ? `${fmtDate(startMs)} ${fmtTime(startMs)}–${fmtTime(endMs)}`
    : `${fmtDate(startMs)} ${fmtTime(startMs)}–${fmtDate(endMs)} ${fmtTime(endMs)}`;
}

module.exports = { fmtDate, fmtTime, fmtRange };
