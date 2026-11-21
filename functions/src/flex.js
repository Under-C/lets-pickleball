// LINE Flex Message 揪團字卡
const { splitEntries } = require("./core");
const { fmtRange } = require("./time");

// 配色：黃色標題列 + 深藍文字與圖示 + 淺橘重點
const YELLOW = "#FFD43B";      // 標題列
const NAVY = "#293A4C";        // 文字、圖示
const ORANGE = "#F28A2E";      // 橘色文字（人數、狀態、候補）
const ORANGE_FILL = "#FFAE5C"; // 橘色填色（圓點、報名按鈕）
const LINE_GRAY = "#E3E6EA";   // 空位圓點、分隔
const BTN_GRAY = "#EEF0F3";    // 一般按鈕
const GRAY = "#6B7785";        // 次要文字
const RED = "#E06666";
const CLOSED_BG = "#D9D4C7";
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
  return { type: "text", text: t, wrap: true, color: NAVY, ...opts };
}

// 圖示放在網站上（docs/icons），iconUrl 是 .../paddle.png，由它推出網站根目錄
const assetBase = (iconUrl) => (iconUrl ? iconUrl.replace(/\/[^/]*$/, "") : "");
const iconOf = (base, name) => `${base}/icons/ic_${name}.png`;

// 一行「圖示 + 文字」
function iconRow(base, name, t, textOpts = {}, iconSize = "sm") {
  if (!base) return text(t, textOpts);
  return {
    type: "box",
    layout: "baseline",
    spacing: "sm",
    contents: [{ type: "icon", url: iconOf(base, name), size: iconSize }, text(t, textOpts)],
  };
}

/**
 * 自訂按鈕（LINE 內建按鈕的主要樣式字一定是白色，所以用方塊自己畫）
 */
function boxBtn(label, action, { bg = BTN_GRAY, color = NAVY, icon } = {}) {
  return {
    type: "box",
    layout: "horizontal",
    flex: 1,
    backgroundColor: bg,
    cornerRadius: "10px",
    paddingTop: "10px",
    paddingBottom: "10px",
    justifyContent: "center",
    alignItems: "center",
    spacing: "sm",
    action,
    contents: [
      ...(icon ? [{ type: "image", url: icon, size: "16px", aspectMode: "fit", flex: 0 }] : []),
      { type: "text", text: label, color, weight: "bold", size: "md", flex: 0 },
    ],
  };
}

function eventBubble(ev, liffId, iconUrl) {
  const base = assetBase(iconUrl);
  const { main, wait } = splitEntries(ev);
  const cap = ev.capacity;
  const liffBase = `https://liff.line.me/${liffId}`;
  const g = ev.groupId ? `&g=${encodeURIComponent(ev.groupId)}` : "";

  const dots = [];
  for (let i = 0; i < Math.min(cap, MAX_DOTS); i++) {
    dots.push(text("●", { flex: 0, size: "lg", color: i < main.length ? ORANGE_FILL : LINE_GRAY, wrap: false }));
  }
  if (cap > MAX_DOTS) dots.push(text(`+${cap - MAX_DOTS}`, { flex: 0, size: "sm", color: GRAY, gravity: "center", wrap: false }));

  const body = [
    iconRow(base, "pin", ev.location, { weight: "bold", size: "md" }, "md"),
    iconRow(base, "calendar", fmtRange(ev.startAt.toMillis(), ev.endAt.toMillis()), { size: "sm" }),
  ];
  if (ev.courts) body.push(iconRow(base, "court", `場地：${ev.courts}`, { size: "sm" }));
  body.push({ type: "separator", margin: "md", color: LINE_GRAY });
  body.push({ type: "box", layout: "horizontal", spacing: "xs", margin: "md", contents: dots });
  body.push({
    type: "box",
    layout: "baseline",
    spacing: "sm",
    contents: [
      ...(base ? [{ type: "icon", url: iconOf(base, "people"), size: "md" }] : []),
      text(`${main.length}/${cap}`, { flex: 0, size: "xl", weight: "bold", color: ORANGE, wrap: false }),
      text(`候補 ${wait.length}`, { flex: 0, size: "sm", color: GRAY, wrap: false, margin: "md" }),
    ],
  });
  body.push(text(statusText(main.length, wait.length, cap), { weight: "bold", color: ORANGE, size: "sm" }));
  if (main.length) body.push(text(`正取：${nameList(main)}`, { size: "xs", color: GRAY }));
  if (wait.length) body.push(text(`候補：${nameList(wait, 4)}`, { size: "xs", color: ORANGE, weight: "bold" }));
  if (ev.note) {
    const note = iconRow(base, "note", ev.note, { size: "sm" });
    note.margin = "md";
    body.push(note);
  }
  if (ev.cancelLock24h) body.push(iconRow(base, "clock", "開打前 24 小時內不可取消正取", { size: "xxs", color: GRAY }, "xs"));

  const isOpen = ev.status === "open";
  return {
    type: "bubble",
    size: "kilo",
    header: {
      type: "box",
      layout: "vertical",
      spacing: "xs",
      backgroundColor: isOpen ? YELLOW : CLOSED_BG,
      paddingAll: "14px",
      contents: [
        {
          type: "box",
          layout: "baseline",
          spacing: "sm",
          contents: [
            ...(iconUrl ? [{ type: "icon", url: iconUrl, size: "xl" }] : []),
            text(ev.title || "匹克球揪團", { weight: "bold", size: "md" }),
            ...(isOpen ? [] : [text("已截止", { size: "xs", flex: 0, wrap: false, weight: "bold" })]),
          ],
        },
        ...(ev.groupName ? [iconRow(base, "people", ev.groupName, { size: "xs", weight: "bold" }, "xs")] : []),
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
            boxBtn("取消 -1", { type: "postback", label: "取消 -1", data: `a=cancel&e=${ev.id}` }),
            boxBtn("報名 +1", { type: "postback", label: "報名 +1", data: `a=join&e=${ev.id}` }, { bg: ORANGE_FILL }),
          ],
        },
        {
          type: "box",
          layout: "horizontal",
          spacing: "sm",
          contents: [
            boxBtn("教學", { type: "uri", label: "教學", uri: `${liffBase}?view=help${g}` }),
            boxBtn("行事曆", { type: "uri", label: "行事曆", uri: `${liffBase}?view=calendar${g}` },
              { icon: base ? iconOf(base, "calendar") : undefined }),
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
          boxBtn(noLabel, { type: "postback", label: noLabel, data: "a=no", displayText: noLabel }),
          boxBtn(okLabel, {
            type: "postback",
            label: okLabel,
            data: `a=${isJoin ? "cjoin" : "ccancel"}&e=${ev.id}&u=${uid}`,
            displayText: okLabel,
          }, isJoin ? { bg: ORANGE_FILL } : { bg: RED, color: "#FFFFFF" }),
        ],
      },
    },
  };
}

/**
 * 開團指令的預覽確認卡。groups = 可以開團的群組（一個以上時讓使用者選）
 */
function createPreviewMessage(data, groups, draftId, iconUrl) {
  const base = assetBase(iconUrl);
  const row = (label, value) => ({
    type: "box",
    layout: "baseline",
    spacing: "md",
    contents: [
      text(label, { size: "sm", color: GRAY, flex: 2, wrap: false }),
      text(value || "—", { size: "sm", flex: 6, weight: "bold" }),
    ],
  });
  const body = [
    row("團名", data.title),
    row("時間", fmtRange(data.startAt, data.endAt)),
    row("地點", data.location),
    row("人數", `${data.capacity} 人`),
    row("備註", data.note),
    { type: "separator", margin: "md", color: LINE_GRAY },
    text("預設：開打前 24 小時內不可取消正取\n要修改內容請重新傳送指令，或到網站管理頁編輯", { size: "xxs", color: GRAY, margin: "md" }),
  ];
  const act = (label, d, display = label) => ({ type: "postback", label: label.slice(0, 20), data: d, displayText: display });
  const cancel = boxBtn("取消", act("取消", `a=xd&d=${draftId}`, "取消開團"));
  let footer;
  if (groups.length === 1) {
    const r = iconRow(base, "people", `開在「${groups[0].name}」`, { size: "sm", weight: "bold" });
    r.margin = "md";
    body.push(r);
    footer = {
      type: "box",
      layout: "horizontal",
      spacing: "sm",
      contents: [cancel, boxBtn("確定開團", act("確定開團", `a=cd&d=${draftId}&g=${groups[0].id}`), { bg: ORANGE_FILL })],
    };
  } else {
    const r = iconRow(base, "people", "要開在哪個群組？", { size: "sm", weight: "bold" });
    r.margin = "md";
    body.push(r);
    footer = {
      type: "box",
      layout: "vertical",
      spacing: "sm",
      contents: [
        ...groups.slice(0, 8).map((g) =>
          boxBtn(`開在「${g.name}」`.slice(0, 20), act(`開在「${g.name}」`, `a=cd&d=${draftId}&g=${g.id}`, `確定開在「${g.name}」`), { bg: ORANGE_FILL })),
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
        contents: [iconRow(base, "note", "開團預覽", { weight: "bold", size: "md" }, "md")],
      },
      body: { type: "box", layout: "vertical", spacing: "sm", contents: body },
      footer,
    },
  };
}

module.exports = { eventBubble, eventsCarousel, eventMessage, confirmMessage, createPreviewMessage, statusText, nameList };
