// LINE Flex Message 揪團字卡
const { splitEntries } = require("./core");
const { fmtRange } = require("./time");

// 配色：亮黃 + 牛仔藍
const BROWN = "#2F5D8C"; // 主色（牛仔藍）：按鈕、人數、進度點
const YELLOW = "#FFD43B"; // 標題列
const INK = "#2B2B2B";
const LIGHT = "#F3E3A0";
const GRAY = "#7A7A7A";
const BLUE = "#7C93B8";
const MAX_DOTS = 12;

function nameList(list, max = 6) {
  if (!list.length) return "";
  const names = list.slice(0, max).map((e) => e.name).join("、");
  return list.length > max ? `${names}、…等 ${list.length} 位` : names;
}

function statusText(mainCount, waitCount, capacity) {
  if (mainCount < capacity) return `還缺 ${capacity - mainCount} 人，快來揪！`;
  if (waitCount > 0) return `額滿囉，候補 ${waitCount} 人排隊中`;
  return "額滿囉！剛剛好一場";
}

function text(t, opts = {}) {
  return { type: "text", text: t, wrap: true, ...opts };
}

function eventBubble(ev, liffId, iconUrl) {
  const { main, wait } = splitEntries(ev);
  const cap = ev.capacity;
  const liffBase = `https://liff.line.me/${liffId}`;
  const g = ev.groupId ? `&g=${encodeURIComponent(ev.groupId)}` : "";

  const dots = [];
  for (let i = 0; i < Math.min(cap, MAX_DOTS); i++) {
    dots.push(text("●", { flex: 0, size: "lg", color: i < main.length ? BROWN : LIGHT, wrap: false }));
  }
  if (cap > MAX_DOTS) dots.push(text(`+${cap - MAX_DOTS}`, { flex: 0, size: "sm", color: GRAY, gravity: "center", wrap: false }));

  const body = [
    text(`📍 ${ev.location}`, { weight: "bold", size: "md" }),
    text(`📅 ${fmtRange(ev.startAt.toMillis(), ev.endAt.toMillis())}`, { size: "sm", color: "#555555" }),
  ];
  if (ev.courts) body.push(text(`🏟️ 場地：${ev.courts}`, { size: "sm", color: "#555555" }));
  body.push({ type: "separator", margin: "md" });
  body.push({ type: "box", layout: "horizontal", spacing: "xs", margin: "md", contents: dots });
  body.push({
    type: "box",
    layout: "baseline",
    spacing: "md",
    contents: [
      text(`👥 ${main.length}/${cap}`, { flex: 0, size: "lg", weight: "bold", color: BROWN, wrap: false }),
      text(`候補 ${wait.length}`, { flex: 0, size: "sm", color: GRAY, wrap: false }),
    ],
  });
  body.push(text(statusText(main.length, wait.length, cap), { weight: "bold", color: BROWN, size: "sm" }));
  if (main.length) body.push(text(`正取：${nameList(main)}`, { size: "xs", color: "#555555" }));
  if (wait.length) body.push(text(`候補：${nameList(wait, 4)}`, { size: "xs", color: BLUE }));
  if (ev.note) body.push(text(`📝 ${ev.note}`, { size: "sm", color: "#555555", margin: "md" }));
  if (ev.cancelLock24h) body.push(text("⏰ 開打前 24 小時內不可取消正取", { size: "xxs", color: GRAY }));

  const btn = (label, action, primary = false) => ({
    type: "button",
    style: primary ? "primary" : "secondary",
    color: primary ? BROWN : undefined,
    height: "sm",
    action: { label, ...action },
  });

  return {
    type: "bubble",
    size: "kilo",
    header: {
      type: "box",
      layout: "vertical",
      spacing: "xs",
      backgroundColor: ev.status === "open" ? YELLOW : "#D9D4C7",
      paddingAll: "14px",
      contents: [
        {
          type: "box",
          layout: "baseline",
          spacing: "sm",
          contents: [
            ...(iconUrl ? [{ type: "icon", url: iconUrl, size: "xl" }] : []),
            text(ev.title || "匹克球揪團", { color: INK, weight: "bold", size: "md" }),
            ...(ev.status === "open" ? [] : [text("🔒 已截止", { color: INK, size: "xs", flex: 0, wrap: false })]),
          ],
        },
        ...(ev.groupName ? [text(`👥 ${ev.groupName}`, { color: BROWN, size: "xs", weight: "bold" })] : []),
      ],
    },
    body: { type: "box", layout: "vertical", spacing: "sm", contents: body },
    footer: {
      type: "box",
      layout: "vertical",
      spacing: "sm",
      contents: [
        {
          type: "box",
          layout: "horizontal",
          spacing: "sm",
          contents: [
            btn("取消 -1", { type: "postback", data: `a=cancel&e=${ev.id}` }),
            btn("報名 +1", { type: "postback", data: `a=join&e=${ev.id}` }, true),
          ],
        },
        {
          type: "box",
          layout: "horizontal",
          spacing: "sm",
          contents: [
            btn("教學", { type: "uri", uri: `${liffBase}?view=help${g}` }),
            btn("📅 行事曆", { type: "uri", uri: `${liffBase}?view=calendar${g}` }),
          ],
        },
      ],
    },
  };
}

function eventsCarousel(events, liffId, iconUrl) {
  return {
    type: "flex",
    altText: `近期揪團（${events.length} 場）`,
    contents: { type: "carousel", contents: events.map((e) => eventBubble(e, liffId, iconUrl)) },
  };
}

// 單場字卡（報名 / 取消後回覆）
function eventMessage(ev, liffId, altText, iconUrl) {
  return { type: "flex", altText: altText || ev.title || "匹克球揪團", contents: eventBubble(ev, liffId, iconUrl) };
}

/**
 * 確認視窗。kind = "join" | "cancel"
 * 按鈕的 postback 帶有本人的 userId，只有本人按才有效。
 */
function confirmMessage(kind, { name, uid, ev }) {
  const isJoin = kind === "join";
  const when = `${ev.location} ${fmtRange(ev.startAt.toMillis(), ev.endAt.toMillis())}`;
  const title = isJoin ? `${name}，確定要報名嗎？（一人一位）` : `${name}，確定要取消報名嗎？`;
  const hint = isJoin
    ? "※ 只有你本人按「確定報名」才算，幫別人報名請他自己按"
    : "※ 只有你本人按「確定取消」才會取消你的名額";
  const okLabel = isJoin ? "確定報名" : "確定取消";
  const noLabel = isJoin ? "先不要" : "按錯了，不取消";
  return {
    type: "flex",
    altText: title,
    contents: {
      type: "bubble",
      size: "kilo",
      body: {
        type: "box",
        layout: "vertical",
        spacing: "sm",
        contents: [
          text(title, { weight: "bold", size: "md" }),
          text(when, { weight: "bold", size: "sm" }),
          text(hint, { size: "xxs", color: GRAY, margin: "md" }),
        ],
      },
      footer: {
        type: "box",
        layout: "horizontal",
        spacing: "sm",
        contents: [
          {
            type: "button",
            style: "secondary",
            height: "sm",
            action: { type: "postback", label: noLabel, data: "a=no", displayText: noLabel },
          },
          {
            type: "button",
            style: "primary",
            color: isJoin ? BROWN : "#E06666",
            height: "sm",
            action: {
              type: "postback",
              label: okLabel,
              data: `a=${isJoin ? "cjoin" : "ccancel"}&e=${ev.id}&u=${uid}`,
              displayText: okLabel,
            },
          },
        ],
      },
    },
  };
}

/**
 * 開團指令的預覽確認卡。groups = 可以開團的群組（一個以上時讓使用者選）
 */
function createPreviewMessage(data, groups, draftId) {
  const row = (label, value) => ({
    type: "box",
    layout: "baseline",
    spacing: "md",
    contents: [
      text(label, { size: "sm", color: GRAY, flex: 2, wrap: false }),
      text(value || "—", { size: "sm", color: INK, flex: 6, weight: "bold" }),
    ],
  });
  const body = [
    row("團名", data.title),
    row("時間", fmtRange(data.startAt, data.endAt)),
    row("地點", data.location),
    row("人數", `${data.capacity} 人`),
    row("備註", data.note),
    { type: "separator", margin: "md" },
    text("⏰ 預設：開打前 24 小時內不可取消正取\n要修改內容請重新傳送指令，或到網站管理頁編輯", { size: "xxs", color: GRAY, margin: "md" }),
  ];
  const btn = (label, data, style = "primary", display = label) => ({
    type: "button",
    style,
    color: style === "primary" ? BROWN : undefined,
    height: "sm",
    action: { type: "postback", label: label.slice(0, 20), data, displayText: display },
  });
  const cancel = btn("取消", `a=xd&d=${draftId}`, "secondary", "取消開團");
  let footer;
  if (groups.length === 1) {
    body.push(text(`👥 開在「${groups[0].name}」`, { size: "sm", color: BROWN, weight: "bold", margin: "md" }));
    footer = { type: "box", layout: "horizontal", spacing: "sm", contents: [cancel, btn("確定開團", `a=cd&d=${draftId}&g=${groups[0].id}`)] };
  } else {
    body.push(text("👥 要開在哪個群組？", { size: "sm", color: BROWN, weight: "bold", margin: "md" }));
    footer = {
      type: "box",
      layout: "vertical",
      spacing: "sm",
      contents: [
        ...groups.slice(0, 8).map((g) => btn(`開在「${g.name}」`, `a=cd&d=${draftId}&g=${g.id}`, "primary", `確定開在「${g.name}」`)),
        cancel,
      ],
    };
  }
  return {
    type: "flex",
    altText: `開團預覽：${data.title}`,
    contents: {
      type: "bubble",
      size: "kilo",
      header: {
        type: "box",
        layout: "vertical",
        backgroundColor: YELLOW,
        paddingAll: "14px",
        contents: [text("📝 開團預覽", { color: INK, weight: "bold", size: "md" })],
      },
      body: { type: "box", layout: "vertical", spacing: "sm", contents: body },
      footer,
    },
  };
}

module.exports = { eventBubble, eventsCarousel, eventMessage, confirmMessage, createPreviewMessage, statusText, nameList };
