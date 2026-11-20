const state = {
  board: null,
  filter: "favourable",
  query: "",
  selected: null
};

const money = new Intl.NumberFormat("en-IN", {
  style: "currency",
  currency: "INR",
  maximumFractionDigits: 2
});
const compact = new Intl.NumberFormat("en-IN", { notation: "compact", maximumFractionDigits: 1 });

function cls(n) {
  return n > 0 ? "up" : n < 0 ? "down" : "";
}
function signed(n) {
  if (n == null) return "—";
  const v = `${n > 0 ? "+" : ""}${n.toFixed(2)}%`;
  return `<span class="${cls(n)}">${v}</span>`;
}

function sparkline(values) {
  if (!values?.length) return "";
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const d = values
    .map((v, i) => {
      const x = (i / (values.length - 1)) * 92;
      const y = 32 - ((v - min) / span) * 28;
      return `${i === 0 ? "M" : "L"}${x.toFixed(1)} ${y.toFixed(1)}`;
    })
    .join(" ");
  const up = values[values.length - 1] >= values[0];
  return `<svg class="spark" viewBox="0 0 92 36" aria-hidden="true"><path d="${d}" fill="none" stroke="${up ? "#3dbe86" : "#ef6d6d"}" stroke-width="2"/></svg>`;
}

function istNow() {
  return new Intl.DateTimeFormat("en-IN", {
    timeZone: "Asia/Kolkata",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    day: "numeric",
    month: "short"
  }).format(new Date());
}

function visibleStocks() {
  const q = state.query.trim().toLowerCase();
  let rows = state.board?.stocks || [];
  if (state.filter === "favourable") rows = rows.filter((s) => s.favourable);
  if (state.filter === "crowded") {
    rows = rows.filter((s) => (s.volRatio || 0) >= 1.3).slice().sort((a, b) => (b.volRatio || 0) - (a.volRatio || 0));
  }
  if (q) {
    rows = rows.filter((s) => `${s.ticker} ${s.name} ${s.sector}`.toLowerCase().includes(q));
  }
  return rows;
}

function render() {
  document.getElementById("clock").textContent = `${istNow()} IST`;
  const board = state.board;
  const nifty = document.getElementById("nifty");
  if (!board) {
    nifty.innerHTML = `<p class="eyebrow">Nifty 50</p><p class="nifty-price">Loading</p>`;
    document.getElementById("list").innerHTML = `<p class="empty">Reading NSE prices… this can take half a minute the first time.</p>`;
    return;
  }

  nifty.innerHTML = `
    <p class="eyebrow">Nifty 50</p>
    <p class="nifty-price">${board.nifty ? money.format(board.nifty.price) : "—"}</p>
    <p class="nifty-change">${board.nifty ? signed(board.nifty.dayPct) : ""}</p>
    ${board.nifty ? sparkline(board.nifty.spark) : ""}
  `;

  const fav = board.favourableCount;
  document.getElementById("stats").innerHTML = [
    ["Scanned", board.scanned],
    ["Favourable", fav],
    ["Advancers", board.advancers],
    ["Decliners", board.decliners]
  ].map(([k, v]) => `<div class="stat"><span>${k}</span><b>${v}</b></div>`).join("");

  const rows = visibleStocks();
  const banner = document.getElementById("banner");
  if (state.filter === "favourable" && fav === 0 && !state.query) {
    banner.hidden = false;
    banner.textContent = "No share cleared every check on this pass. Switch to Most crowded or Full list to see who is still active.";
  } else {
    banner.hidden = true;
  }

  const list = document.getElementById("list");
  if (!rows.length) {
    list.innerHTML = `<p class="empty">Nothing matches this view.</p>`;
  } else {
    list.innerHTML = rows.map((s) => `
      <button class="row ${s.ticker === state.selected ? "selected" : ""}" data-ticker="${s.ticker}">
        <div class="score" style="--p:${s.score}"><span>${s.score}</span></div>
        <div>
          <div class="ticker">${s.ticker} <span class="heat">${s.heat}</span></div>
          <div class="sub">${s.sector} · vol ${s.volRatio == null ? "—" : s.volRatio.toFixed(1) + "×"} · 5d ${s.ret5 == null ? "—" : (s.ret5 > 0 ? "+" : "") + s.ret5.toFixed(1) + "%"}</div>
        </div>
        <div class="px">
          <b>${money.format(s.price)}</b>
          ${signed(s.dayPct)}
        </div>
        ${sparkline(s.spark)}
      </button>
    `).join("");
  }

  const picked = (state.board.stocks || []).find((s) => s.ticker === state.selected) || rows[0];
  const detail = document.getElementById("detail");
  if (!picked) {
    detail.innerHTML = `<p class="muted">No share selected.</p>`;
    return;
  }
  state.selected = picked.ticker;
  const parts = [
    ["Crowd", picked.parts.activity, 35],
    ["Buyers", picked.parts.confirmation, 25],
    ["Trend", picked.parts.trend, 25],
    ["Room", picked.parts.setup, 15]
  ];
  detail.innerHTML = `
    ${picked.favourable ? `<span class="tag">Favourable setup</span>` : `<span class="tag" style="background:rgba(230,162,60,.15);color:#ffd27a">${picked.heat}</span>`}
    <h3>${picked.ticker}</h3>
    <p class="name">${picked.name}</p>
    <p>${money.format(picked.price)} ${signed(picked.dayPct)} today</p>
    <p class="sub">Volume ${compact.format(picked.volume)} vs avg ${picked.avgVolume ? compact.format(picked.avgVolume) : "—"} · 20d ${picked.ret20 == null ? "—" : (picked.ret20 > 0 ? "+" : "") + picked.ret20.toFixed(1) + "%"}</p>
    ${sparkline(picked.spark)}
    <div class="bars">
      ${parts.map(([name, value, max]) => `<div class="bar"><span>${name}</span><i style="--w:${(value / max) * 100}"></i><b>${value}</b></div>`).join("")}
    </div>
    <ul class="why">${picked.why.map((w) => `<li>${w}</li>`).join("")}</ul>
    ${picked.caution.length ? `<ul class="caution">${picked.caution.map((w) => `<li>${w}</li>`).join("")}</ul>` : ""}
    <p class="sub">Score ${picked.score} out of 100. This is not a recommendation to buy.</p>
  `;
}

async function load() {
  document.getElementById("refresh").disabled = true;
  try {
    const res = await fetch("/api/board");
    if (!res.ok) throw new Error("bad");
    state.board = await res.json();
    if (!state.selected && state.board.stocks[0]) {
      const fav = state.board.stocks.find((s) => s.favourable);
      state.selected = (fav || state.board.stocks[0]).ticker;
    }
    render();
  } catch {
    document.getElementById("list").innerHTML = `<p class="empty">Could not load market data. Check the connection and press Refresh.</p>`;
  } finally {
    document.getElementById("refresh").disabled = false;
  }
}

document.getElementById("refresh").addEventListener("click", load);
document.getElementById("q").addEventListener("input", (e) => {
  state.query = e.target.value;
  render();
});
document.querySelector(".filters").addEventListener("click", (e) => {
  const btn = e.target.closest("[data-filter]");
  if (!btn) return;
  state.filter = btn.dataset.filter;
  document.querySelectorAll(".chip").forEach((c) => c.classList.toggle("on", c === btn));
  render();
});
document.getElementById("list").addEventListener("click", (e) => {
  const row = e.target.closest("[data-ticker]");
  if (!row) return;
  state.selected = row.dataset.ticker;
  render();
});

render();
load();
setInterval(() => document.getElementById("clock").textContent = `${istNow()} IST`, 30000);
