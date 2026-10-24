// Canvas -> HTML for the browser view. It renders the same plan as the native client (shared/plan.ts) with the
// string primitives in ui-html.ts, so what a block means is decided once. Everything agent-supplied goes through
// esc(); there is no innerHTML path for agent text and no script in the output.
import { planBlocks, rowPlan, selfStatus, statusPlan, type BlockPlan } from "../shared/plan.ts";
import type { CanvasView } from "../shared/contract.ts";
import { COMPONENT_CSS, badge, bar, button, chip, cssVars, delta, esc, glyphCircle, meta, sd, slabel, statusLine, stepRow, ticks } from "./ui-html.ts";
import type { Node } from "../shared/canvas.ts";

export { esc };

function lineChart(points: { label: string; value: number }[]): string {
  const W = 360, H = 110, pad = 18;
  const max = Math.max(...points.map((p) => p.value), 1);
  const step = points.length > 1 ? (W - pad * 2) / (points.length - 1) : 0;
  const xy = points.map((p, i) => [pad + step * i, H - pad - (p.value / max) * (H - pad * 2 - 8)] as const);
  const path = xy.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  const area = `${path} L${xy[xy.length - 1][0].toFixed(1)},${H - pad} L${xy[0][0].toFixed(1)},${H - pad} Z`;
  return `<svg class="svgchart" viewBox="0 0 ${W} ${H}" role="img"><defs><linearGradient id="ag" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="var(--run)" stop-opacity=".18"/><stop offset="1" stop-color="var(--run)" stop-opacity="0"/></linearGradient></defs>
    <line x1="${pad}" x2="${W - pad}" y1="${H - pad}" y2="${H - pad}" stroke="var(--line-strong)"/><path d="${area}" fill="url(#ag)"/><path d="${path}" fill="none" stroke="var(--run)" stroke-width="2"/>
    ${xy.map(([x, y], i) => `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="3" fill="var(--bg)" stroke="var(--run)" stroke-width="2"/><text class="v" x="${x.toFixed(1)}" y="${(y - 8).toFixed(1)}" text-anchor="middle">${esc(points[i].value)}</text><text x="${x.toFixed(1)}" y="${H - 4}" text-anchor="middle">${esc(points[i].label)}</text>`).join("")}</svg>`;
}

export function renderPlan(p: BlockPlan, agentId: string): string {
  switch (p.kind) {
    case "bluf": return `<p class="lede">${esc(p.text)}</p>`;
    case "steps": return `<div class="sec">${slabel(p.label, { ticks: p.ticks, count: p.count })}<div class="steps">${p.rows.map((r) => stepRow(r.state, r.signal, r.text)).join("")}</div></div>`;
    case "progress": return `<div class="sec prog"><div class="top">${meta(p.label)}<b class="c-${p.signal}">${esc(p.text)}</b></div>${bar(p.pct, p.signal, { ticks: true })}</div>`;
    case "metrics":
      return `<div class="metrics">${p.items.map((m) => `<div class="metric">${meta(m.label)}<div class="v${m.valueSignal ? ` c-${m.valueSignal}` : ""}">${esc(m.head)}${m.delta ? delta(m.delta) : ""}</div></div>`).join("")}</div>`;
    case "decision": return `<div class="sec">${slabel(p.label)}${p.chosen ? chip("ok", p.chosen, "✓ ") : ""}${p.reason ? `<div class="c-idle">${esc(p.reason)}</div>` : ""}</div>`;
    case "ask":
      if (p.answered !== null) return `<div class="sec">${slabel("Answered")}<div class="c-idle">${esc(p.question)}</div>${chip("ok", p.answered, "✓ ")}</div>`;
      return `<div class="ask"><div class="slabel">${sd("hot", { halo: false, pulse: false, size: 6 })}<span>Question</span></div><div class="q">${esc(p.question)}</div><div class="btns">${p.options.map((o) => button("secondary", o.label, `data-agent="${esc(agentId)}" data-ask="${esc(p.id)}" data-value="${esc(o.value)}"`)).join("")}</div></div>`;
    case "diff":
      return `<div class="sec">${p.file ? `<div class="pathrow"><span class="path">${esc(p.file)}</span><span class="dstat"><span class="a">+${p.add}</span> <span class="d">−${p.del}</span></span></div>` : ""}<div class="well">${p.lines.map((l) => `<span class="${l.kind === "ctx" ? "" : l.kind}">${esc(l.text || " ")}</span>`).join("")}</div></div>`;
    case "code": return `<div class="well code">${p.text.split("\n").map((l) => `<span>${esc(l || " ")}</span>`).join("")}</div>`;
    case "chart": {
      const max = Math.max(...p.points.map((q) => q.value), 1);
      const body = p.line ? lineChart(p.points) : `<div class="chartrows">${p.points.map((q) => `<div><div class="top"><span>${esc(q.label)}</span><b style="font-weight:500">${esc(q.value)}</b></div>${bar((q.value / max) * 100, "run")}</div>`).join("")}</div>`;
      return `<div class="sec">${p.label ? slabel(p.label) : ""}${body}</div>`;
    }
    case "table":
      return `<table class="tbl"><thead><tr>${p.cols.map((c, i) => `<th${p.numeric[i] ? ' class="num"' : ""}>${esc(c)}</th>`).join("")}</tr></thead><tbody>${p.rows.map((r) => `<tr>${r.map((c, i) => `<td class="${[p.numeric[i] ? "num" : "", c.best ? "best" : ""].join(" ").trim()}">${esc(c.text)}</td>`).join("")}</tr>`).join("")}</tbody></table>`;
    case "link": return `<p style="margin:0"><a href="${esc(p.href)}" target="_blank" rel="noopener noreferrer">${esc(p.text)} ↗</a></p>`;
    case "note": return `<div class="note ${p.signal}">${glyphCircle(p.signal, p.glyph, true)}<span>${esc(p.text)}</span></div>`;
  }
}

export function renderBlocks(root: Node, agentId: string): string {
  return planBlocks(root).map((p) => renderPlan(p, agentId)).join("");
}

/** One canvas: Paseo's status line, then the title row, then the blocks. */
export function renderCanvas(v: CanvasView, now: number): string {
  const sp = statusPlan(v, now);
  const me = selfStatus(v, sp.label);
  const blocks = renderBlocks(v.tree, v.agentId);
  return `<article class="canvas${sp.dim ? " dim" : ""}"><div class="sheet">${statusLine(sp)}<div class="trow dimmable"><span class="title">${esc(v.title)}</span>${meta(`· ${me.text}`, me.contradicted ? "c-warn" : "")}${v.agentUrl ? `<span style="margin-left:auto"><a href="${esc(v.agentUrl)}" target="_blank" rel="noopener noreferrer">Open agent in Paseo ↗</a></span>` : ""}</div><div class="sheet dimmable">${blocks || '<span class="c-idle">Nothing yet.</span>'}</div></div></article>`;
}

/** The Canvases list: one row per agent; the row that needs you is the only filled one. */
export function renderIndex(views: CanvasView[], now: number): string {
  if (!views.length) return '<p class="c-idle">No agents yet.</p>';
  const plans = views.map((v) => rowPlan(v, now));
  const need = plans.filter((p) => p.needsYou).length;
  const head = `<div class="sheet" style="margin-bottom:12px"><div class="trow" style="align-items:center"><span class="screentitle">Canvases</span>${need ? badge("hot", `${need} need you`) : ""}</div>${meta("Every agent's live view of its work. Tap one to open it.")}</div>`;
  return `${head}<div class="list">${plans
    .map(
      (p) => `<a class="row${p.needsYou ? " need" : ""}${p.dim ? " dim" : ""}" href="/a/${esc(p.agentId)}"><div class="l1">${sd(p.signal)}<b>${esc(p.title)}</b>${ticks(p.ticks)}<span class="sp"></span>${badge(p.signal, p.label, p.signal === "ok" ? "check" : "dot")}</div>${p.bluf ? `<div class="ind bl">${esc(p.bluf)}</div>` : ""}<div class="ind">${meta(p.meta)}</div>${p.flag ? `<div class="ind">${`<div class="flag ${p.flag.signal}">${glyphCircle(p.flag.signal, p.flag.glyph)}<span>${esc(p.flag.text)}</span></div>`}</div>` : ""}</a>`,
    )
    .join("")}</div>`;
}

const SCRIPT = `
const root=document.getElementById('root');const url=root.dataset.frag;
async function tick(){try{const r=await fetch(url,{cache:'no-store'});if(r.ok){const h=await r.text();if(h!==root.dataset.last){root.innerHTML=h;root.dataset.last=h}}}catch(e){}}
setInterval(tick,1500);tick();
document.addEventListener('click',async e=>{const b=e.target.closest('button[data-ask]');if(!b)return;b.disabled=true;
const r=await fetch('/api/answer',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({agentId:b.dataset.agent,askId:b.dataset.ask,value:b.dataset.value})});
const j=await r.json().catch(()=>({}));if(!j.ok){alert(j.error||'failed');b.disabled=false}tick();});
`;

export function page(title: string, body: string, frag: string, crumbs = ""): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><title>${esc(title)}</title><style>${cssVars()}${COMPONENT_CSS}</style></head><body><nav><a href="/">Canvases</a>${crumbs}<span class="demo">agent-canvas demo</span></nav><main><div id="root" data-frag="${esc(frag)}" data-last="">${body}</div></main><script>${SCRIPT}</script></body></html>`;
}
