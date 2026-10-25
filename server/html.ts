// Canvas -> HTML for the browser view. It renders the same plan as the native client (shared/plan.ts) with the
// string primitives in ui-html.ts, so what a block means is decided once. Everything agent-supplied goes through
// esc(); there is no innerHTML path for agent text and no script in the output.
import { planBlocks, rowPlan, selfStatus, statusPlan, type BlockPlan } from "../shared/plan.ts";
import { PAGE_CONTENT_WIDTH, gridColumns } from "../shared/ui-spec.ts";
import type { CanvasView } from "../shared/contract.ts";
import { COMPONENT_CSS, badge, bar, button, chip, cssVars, delta, esc, glyphCircle, jobChip, meta, sd, slabel, statusLine, stepRow, ticks } from "./ui-html.ts";
import type { Node } from "../shared/canvas.ts";
import type { Inline, MdBlock } from "../shared/markdown.ts";

export { esc };

/** What the HTML needs from the server beyond the tree: the safe markup of a drawing, by hash. */
export type RenderCtx = { svg?: (hash: string) => string | null;
  /** The card for another page (embed mode): no buttons, no script, sections closed, images at absolute URLs under `assetBase`. */
  embed?: boolean; assetBase?: string };

const unavailable = (what: string, alt: string) => `<div class="figmiss">${esc(alt ? `${what}: ${alt}` : `${what} unavailable`)}</div>`;
const figure = (hash: string | null, alt: string, w: number, h: number, base = "") =>
  hash ? `<figure class="fig"><img src="${esc(base)}/asset/${esc(hash)}" alt="${esc(alt)}"${w && h ? ` width="${w}" height="${h}"` : ""} loading="lazy"></figure>` : unavailable("Image", alt);


const mdInline = (c: Inline[]): string =>
  c.map((i) => {
    switch (i.t) {
      case "text": return esc(i.v).replace(/\n/g, "<br>");
      case "code": return `<code>${esc(i.v)}</code>`;
      case "strong": return `<strong>${mdInline(i.c)}</strong>`;
      case "em": return `<em>${mdInline(i.c)}</em>`;
      case "del": return `<del>${mdInline(i.c)}</del>`;
      case "link": return `<a href="${esc(i.href)}" target="_blank" rel="noopener noreferrer">${mdInline(i.c)}</a>`;
    }
  }).join("");

function mdBlock(b: MdBlock): string {
  switch (b.k) {
    case "heading": return `<h${Math.min(b.level + 1, 6)} class="mdh${b.level}">${mdInline(b.c)}</h${Math.min(b.level + 1, 6)}>`;
    case "paragraph": return `<p>${mdInline(b.c)}</p>`;
    case "hr": return `<div class="divider"></div>`;
    case "code": return `<div class="well code">${b.text.split("\n").map((l) => `<span>${esc(l || " ")}</span>`).join("")}</div>`;
    case "quote": return `<blockquote>${b.blocks.map(mdBlock).join("")}</blockquote>`;
    case "alert": return `<div class="note ${b.signal}">${glyphCircle(b.signal, b.glyph, true)}<div class="mdbody"><b class="c-${b.signal}">${esc(b.title)}</b>${b.blocks.map(mdBlock).join("")}</div></div>`;
    case "list": {
      const tag = b.ordered ? "ol" : "ul";
      return `<${tag}${b.ordered && b.start !== 1 ? ` start="${b.start}"` : ""}>${b.items.map((it) => `<li${it.checked === null ? "" : ' class="task"'}>${it.checked === null ? "" : `<span class="chk${it.checked ? " on" : ""}" role="img" aria-label="${it.checked ? "done" : "not done"}">${it.checked ? "✓" : ""}</span>`}<div>${it.blocks.map(mdBlock).join("")}</div></li>`).join("")}</${tag}>`;
    }
    case "image": return figure(b.hash ?? null, b.alt, b.w ?? 0, b.h ?? 0);
    case "table": {
      const al = (i: number, extra = "") => {
        const cls = [b.numeric[i] || b.align[i] === "right" ? "num" : b.align[i] === "center" ? "ctr" : "", extra].join(" ").trim();
        return cls ? ` class="${cls}"` : "";
      };
      return `<table class="tbl"><thead><tr>${b.head.map((c, i) => `<th${al(i)}>${mdInline(c)}</th>`).join("")}</tr></thead><tbody>${b.rows.map((r) => `<tr>${r.map((c, i) => `<td${al(i, c.best ? "best" : "")}>${mdInline(c.c)}</td>`).join("")}</tr>`).join("")}</tbody></table>`;
    }
  }
}

/** In embed mode (many canvases on one page, no script of ours) a fold gets a page-unique id, so the host page can keep it open across refreshes. */
const foldId = (agentId: string, kind: "c" | "d", id: string, ctx: RenderCtx) => (ctx.embed ? ` id="cv-${esc(agentId)}-${kind}-${esc(id)}"` : "");

export function renderPlan(p: BlockPlan, agentId: string, ctx: RenderCtx = {}): string {
  switch (p.kind) {
    case "bluf": return `<p class="lede">${esc(p.text)}</p>`;
    case "steps": return `<div class="sec">${slabel(p.label, { ticks: p.ticks, count: p.count })}<div class="steps">${p.rows.map((r) => stepRow(r.state, r.signal, r.text)).join("")}</div></div>`;
    case "progress": return `<div class="sec prog"><div class="top">${meta(p.label)}<b class="c-${p.signal}">${esc(p.text)}</b></div>${bar(p.pct, p.signal, { ticks: true })}</div>`;
    case "metrics":
      return `<div class="metrics">${p.items.map((m) => `<div class="metric">${meta(m.label)}<div class="v${m.valueSignal ? ` c-${m.valueSignal}` : ""}">${esc(m.head)}${m.delta ? delta(m.delta) : ""}</div></div>`).join("")}</div>`;
    case "decision": return `<div class="sec">${slabel(p.label)}${p.chosen ? chip("ok", p.chosen, "✓ ") : ""}${p.reason ? `<div class="c-idle">${esc(p.reason)}</div>` : ""}</div>`;
    case "ask":
      if (p.answered !== null) return `<div class="sec">${slabel("Answered")}<div class="c-idle">${esc(p.question)}</div>${chip("ok", p.answered, "✓ ")}</div>`;
      if (p.pending !== null) return `<div class="ask"><div class="slabel">${sd("hot", { halo: false, pulse: false, size: 6 })}<span>Question</span></div><div class="q">${esc(p.question)}</div>${chip("run", `Sent to the first mate: ${p.pending}`, "… ")}</div>`;
      if (ctx.embed) return `<div class="ask"><div class="slabel">${sd("hot", { halo: false, pulse: false, size: 6 })}<span>Question</span></div><div class="q">${esc(p.question)}</div>${meta("Answer on the card")}</div>`;
      return `<div class="ask"><div class="slabel">${sd("hot", { halo: false, pulse: false, size: 6 })}<span>Question</span></div><div class="q">${esc(p.question)}</div><div class="btns">${p.options.map((o) => button("secondary", o.label, `data-agent="${esc(agentId)}" data-ask="${esc(p.id)}" data-value="${esc(o.value)}"`)).join("")}</div></div>`;
    case "diff": {
      const [stat] = p.summary.split(" · ").slice(-1);
      const head = p.summary.slice(0, p.summary.length - stat.length - 3);
      return `<details class="diff"${foldId(agentId, "d", p.id, ctx)} data-k="d-${esc(p.id)}"><summary><span class="path">${esc(head)}</span><span class="dstat"><span class="a">+${p.add}</span> <span class="d">−${p.del}</span></span></summary>${p.files.length > 1 ? `<div class="meta">${p.files.map(esc).join("<br>")}</div>` : ""}<div class="well">${p.lines.map((l) => `<span class="${l.kind === "ctx" ? "" : l.kind}">${esc(l.text || " ")}</span>`).join("")}</div></details>`;
    }
    case "markdown": return `<div class="md">${p.blocks.map(mdBlock).join("")}</div>`;
    case "svg": {
      const svg = p.hash ? ctx.svg?.(p.hash) : null;
      return svg ? `<div class="svgwrap" style="--w:${Math.round(p.w)}px" role="img" aria-label="${esc(p.alt)}">${svg}</div>` : unavailable("Drawing", p.alt);
    }
    case "image": return figure(p.hash, p.alt, p.w, p.h, ctx.assetBase);
    case "grid": return `<div class="grid" style="--cols:${gridColumns(p.cols, PAGE_CONTENT_WIDTH, p.wide)}">${p.children.map((c) => `<div class="cell">${renderPlan(c, agentId, ctx)}</div>`).join("")}</div>`;
    case "collapse": return `<details class="collapse"${foldId(agentId, "c", p.id, ctx)} data-k="c-${esc(p.id)}"${p.open && !ctx.embed ? " open" : ""}><summary>${esc(p.title)}</summary><div class="cbody">${p.children.map((c) => renderPlan(c, agentId, ctx)).join("")}</div></details>`;
  }
}

export function renderBlocks(root: Node, agentId: string, ctx: RenderCtx = {}): string {
  return planBlocks(root).map((p) => renderPlan(p, agentId, ctx)).join("");
}

/** One canvas: Paseo's status line, then the title row, then the blocks. */
export function renderCanvas(v: CanvasView, now: number, ctx: RenderCtx = {}): string {
  const sp = statusPlan(v, now);
  const me = selfStatus(v, sp.label);
  const blocks = renderBlocks(v.tree, v.agentId, ctx);
  const card = `<article class="canvas${sp.dim ? " dim" : ""}"><div class="sheet">${statusLine(sp, ctx.embed ? `cv-${esc(v.agentId)}` : undefined)}<div class="trow dimmable"><span class="title">${esc(v.title)}</span>${meta(`· ${me.text}`, me.contradicted ? "c-warn" : "")}${v.agentUrl ? `<span style="margin-left:auto"><a href="${esc(v.agentUrl)}" target="_blank" rel="noopener noreferrer">Open agent in Paseo ↗</a></span>` : ""}</div><div class="sheet dimmable">${blocks || '<span class="c-idle">Nothing yet.</span>'}</div></div></article>`;
  return ctx.embed ? `<div class="acv">${card}</div>` : card;
}

/** The Canvases list: one row per agent; the row that needs you is the only filled one. */
export function renderIndex(views: CanvasView[], now: number): string {
  if (!views.length) return '<p class="c-idle">No agents yet.</p>';
  const plans = views.map((v) => rowPlan(v, now));
  const need = plans.filter((p) => p.needsYou).length;
  const head = `<div class="sheet" style="margin-bottom:12px"><div class="trow" style="align-items:center"><span class="screentitle">Canvases</span>${need ? badge("hot", `${need} need you`) : ""}</div>${meta("Every agent's live view of its work. Tap one to open it.")}</div>`;
  return `${head}<div class="list">${plans
    .map(
      (p) => `<a class="row${p.needsYou ? " need" : ""}${p.dim ? " dim" : ""}" href="/a/${esc(p.agentId)}"><div class="l1">${sd(p.signal)}<b>${esc(p.title)}</b>${ticks(p.ticks)}<span class="sp"></span>${badge(p.signal, p.label, p.signal === "ok" ? "check" : "dot")}</div>${p.bluf ? `<div class="ind bl">${esc(p.bluf)}</div>` : ""}<div class="ind">${meta(p.meta)}${p.jobs ? jobChip(p.jobs) : ""}</div>${p.flag ? `<div class="ind">${`<div class="flag ${p.flag.signal}">${glyphCircle(p.flag.signal, p.flag.glyph)}<span>${esc(p.flag.text)}</span></div>`}</div>` : ""}</a>`,
    )
    .join("")}</div>`;
}

const SCRIPT = `
const root=document.getElementById('root');const url=root.dataset.frag;
async function tick(){try{const r=await fetch(url,{cache:'no-store'});if(r.ok){const h=await r.text();if(h!==root.dataset.last){const o=[...root.querySelectorAll('details[open]')].map(d=>d.dataset.k);root.innerHTML=h;root.dataset.last=h;o.forEach(k=>{const d=root.querySelector('details[data-k="'+k+'"]');if(d)d.setAttribute('open','')})}}}catch(e){}}
setInterval(tick,1500);tick();
document.addEventListener('click',async e=>{const b=e.target.closest('button[data-ask]');if(!b)return;b.disabled=true;
const r=await fetch('/api/answer',{method:'POST',headers:{'content-type':'application/json','x-canvas-token':document.querySelector('meta[name=canvas-token]')?.content||''},body:JSON.stringify({agentId:b.dataset.agent,askId:b.dataset.ask,value:b.dataset.value})});
const j=await r.json().catch(()=>({}));if(!j.ok){alert(j.error||'failed');b.disabled=false}tick();});
`;

export function page(title: string, body: string, frag: string, crumbs = "", token = ""): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><meta name="canvas-token" content="${esc(token)}"><title>${esc(title)}</title><style>${cssVars()}${COMPONENT_CSS}</style></head><body><nav><a href="/">Canvases</a>${crumbs}<span class="demo">agent-canvas demo</span></nav><main><div id="root" data-frag="${esc(frag)}" data-last="">${body}</div></main><script>${SCRIPT}</script></body></html>`;
}
