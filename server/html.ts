// Canvas tree -> HTML for the browser view. Everything agent-supplied goes through esc(); there is no
// innerHTML path for agent text and no script in the output.
import { chartPoints, type Node } from "../shared/canvas.ts";
import type { CanvasView } from "../shared/contract.ts";
import { checkHonesty, type Verdict } from "../shared/honesty.ts";

export const esc = (s: unknown) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const ICON: Record<string, string> = { done: "✓", active: "●", pending: "○", failed: "✕", skipped: "–" };

function chart(n: Node): string {
  const pts = chartPoints(String(n.attrs.data)) ?? [];
  const W = 320, H = 110, pad = 18;
  const max = Math.max(...pts.map((p) => p.value), 1);
  const bw = (W - pad * 2) / pts.length;
  let body = "";
  if (n.attrs.kind === "line") {
    const xy = pts.map((p, i) => [pad + bw * (i + 0.5), H - pad - (p.value / max) * (H - pad * 2)]);
    body = `<polyline fill="none" stroke="var(--accent)" stroke-width="2" points="${xy.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(" ")}"/>` + xy.map(([x, y]) => `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="3" fill="var(--accent)"/>`).join("");
  } else {
    body = pts.map((p, i) => { const h = (p.value / max) * (H - pad * 2); return `<rect x="${(pad + bw * i + 4).toFixed(1)}" y="${(H - pad - h).toFixed(1)}" width="${(bw - 8).toFixed(1)}" height="${h.toFixed(1)}" rx="3" fill="var(--accent)"/>`; }).join("");
  }
  const labels = pts.map((p, i) => `<text x="${(pad + bw * (i + 0.5)).toFixed(1)}" y="${H - 4}" text-anchor="middle" font-size="9" fill="var(--muted)">${esc(p.label)}</text><text x="${(pad + bw * (i + 0.5)).toFixed(1)}" y="${(H - pad - (p.value / max) * (H - pad * 2) - 4).toFixed(1)}" text-anchor="middle" font-size="9" fill="var(--fg)">${esc(p.value)}</text>`).join("");
  return `<figure class="chart">${n.attrs.title ? `<figcaption>${esc(n.attrs.title)}</figcaption>` : ""}<svg viewBox="0 0 ${W} ${H}" role="img">${body}${labels}</svg></figure>`;
}

function diff(text: string): string {
  return `<pre class="diff">${text.split("\n").map((l) => `<span class="${l.startsWith("+") ? "add" : l.startsWith("-") ? "del" : l.startsWith("@@") ? "hunk" : ""}">${esc(l)}</span>`).join("\n")}</pre>`;
}

/** Children in order, with runs of Metrics shown side by side. */
export function renderChildren(children: Node[], agentId: string): string {
  let out = "";
  for (let i = 0; i < children.length; i++) {
    if (children[i].tag !== "Metric") { out += renderNode(children[i], agentId); continue; }
    let j = i;
    while (j < children.length && children[j].tag === "Metric") j++;
    out += `<div class="metrics">${children.slice(i, j).map((c) => renderNode(c, agentId)).join("")}</div>`;
    i = j - 1;
  }
  return out;
}

export function renderNode(n: Node, agentId: string): string {
  const kids = () => renderChildren(n.children, agentId);
  switch (n.tag) {
    case "Canvas": return kids();
    case "Bluf": return `<p class="bluf">${esc(n.text)}</p>`;
    case "Steps": return `<section class="card"><h3>${esc(n.attrs.title ?? "Steps")}</h3><ol class="steps">${kids()}</ol></section>`;
    case "Step": return `<li class="step ${esc(n.attrs.state)}"><span class="ic">${ICON[String(n.attrs.state)]}</span><span>${esc(n.text)}</span></li>`;
    case "Progress": {
      const max = Number(n.attrs.max ?? 100) || 100;
      const pct = Math.max(0, Math.min(100, (Number(n.attrs.value) / max) * 100));
      return `<div class="progress"><div class="pl">${esc(n.attrs.label ?? "")}<b>${Math.round(pct)}%</b></div><div class="bar"><i style="width:${pct.toFixed(1)}%"></i></div></div>`;
    }
    case "Metric": return `<div class="metric tone-${esc(n.attrs.tone ?? "info")}"><small>${esc(n.attrs.label)}</small><b>${esc(n.attrs.value)}</b></div>`;
    case "Decision": return `<section class="card"><h3>Decision · ${esc(n.attrs.title)}</h3>${n.attrs.chosen ? `<p class="chosen">→ ${esc(n.attrs.chosen)}</p>` : ""}<p class="muted">${esc(n.text)}</p></section>`;
    case "Ask": {
      const answered = n.attrs.answer ? String(n.attrs.answer) : null;
      const opts = n.children.map((o) => {
        const v = String(o.attrs.value);
        return answered === null
          ? `<button class="opt" data-agent="${esc(agentId)}" data-ask="${esc(n.id)}" data-value="${esc(v)}">${esc(o.text || v)}</button>`
          : `<span class="opt ${answered === v ? "picked" : "off"}">${esc(o.text || v)}</span>`;
      }).join("");
      return `<section class="card ask ${answered === null ? "open" : "answered"}"><h3>${answered === null ? "Question" : "Answered"}</h3><p class="q">${esc(n.attrs.question)}</p><div class="opts">${opts}</div></section>`;
    }
    case "Diff": return `<section class="card">${n.attrs.file ? `<h3 class="mono">${esc(n.attrs.file)}</h3>` : ""}${diff(n.text)}</section>`;
    case "Chart": return `<section class="card">${chart(n)}</section>`;
    case "Table": {
      const cols = String(n.attrs.cols).split("|");
      return `<section class="card"><table><thead><tr>${cols.map((c) => `<th>${esc(c.trim())}</th>`).join("")}</tr></thead><tbody>${n.children.map((r) => `<tr>${r.text.split("|").map((c) => `<td>${esc(c.trim())}</td>`).join("")}</tr>`).join("")}</tbody></table></section>`;
    }
    case "Link": return `<p><a href="${esc(n.attrs.href)}" target="_blank" rel="noopener noreferrer">${esc(n.text || n.attrs.href)}</a></p>`;
    case "Note": return `<p class="note tone-${esc(n.attrs.tone ?? "info")}">${esc(n.text)}</p>`;
    case "Code": return `<pre class="code">${esc(n.text)}</pre>`;
    default: return "";
  }
}

const ago = (ms: number) => { const s = Math.max(0, Math.round(ms / 1000)); return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${Math.floor(s / 3600)}h`; };

export function verdictFor(v: CanvasView, now: number): Verdict {
  return checkHonesty(v.tree, { runState: v.runState, canvasUpdatedAt: v.updatedAt, toolCallsSinceUpdate: Math.max(0, v.callsNow - v.callsAtUpdate), now });
}

/** The Paseo-owned strip: built only from Paseo facts and the verdict, never from canvas text. */
export function renderStrip(v: CanvasView, verdict: Verdict, now: number): string {
  const since = v.updatedAt == null ? "never written (auto canvas)" : `${ago(now - v.updatedAt)} ago`;
  return `<div class="strip run-${esc(v.runState)} verdict-${esc(verdict.label.replace(" ", "-").toLowerCase())}">
    <span class="dot"></span><b>${esc(verdict.label)}</b>
    <span>Paseo: ${esc(v.runState)}</span>
    <span>${v.currentTool ? `running ${esc(v.currentTool)}` : "no tool running"}</span>
    <span>active ${ago(now - v.lastActivityAt)} ago</span>
    <span>canvas updated ${since}</span>
    <span>${v.callsNow - v.callsAtUpdate} tool calls since</span>
  </div>${verdict.flags.filter((f) => f.severity !== "info" || f.code === "needs-you").map((f) => `<div class="flag sev-${f.severity}">${f.severity === "error" ? "⛔" : f.severity === "warn" ? "⚠️" : "🔔"} ${esc(f.text)}</div>`).join("")}`;
}

export function renderCanvas(v: CanvasView, now: number): string {
  const verdict = verdictFor(v, now);
  const t = v.tree;
  return `${renderStrip(v, verdict, now)}<article class="canvas${verdict.dim ? " dim" : ""}">
    <header><h1>${esc(v.title)}</h1>${v.auto ? '<span class="tag">auto canvas</span>' : `<span class="tag st-${esc(t.attrs.status ?? "working")}">${esc(t.attrs.status ?? "working")}</span>`}</header>
    <div class="blocks">${renderChildren(t.children, v.agentId) || '<p class="muted">Nothing yet.</p>'}</div>
  </article>`;
}

export function renderIndex(views: CanvasView[], now: number): string {
  if (!views.length) return '<p class="muted">No agents yet.</p>';
  return `<div class="grid">${views
    .map((v) => {
      const verdict = verdictFor(v, now);
      const bluf = v.tree.children.find((c) => c.tag === "Bluf");
      return `<a class="tile verdict-${esc(verdict.label.replace(" ", "-").toLowerCase())}${verdict.dim ? " dim" : ""}" href="/a/${esc(v.agentId)}">
        <div class="tt"><b>${esc(v.title)}</b><span class="pill">${esc(verdict.label)}</span></div>
        <p>${esc(bluf?.text ?? "")}</p>
        <small>${v.auto ? "auto canvas" : "agent canvas"} · ${esc(v.runState)}${v.currentTool ? ` · ${esc(v.currentTool.slice(0, 50))}` : ""}</small>
        ${verdict.flags.filter((f) => f.severity !== "info" || f.code === "needs-you").map((f) => `<em>${esc(f.text)}</em>`).join("")}
      </a>`;
    })
    .join("")}</div>`;
}

const CSS = `
:root{--bg:#0f1115;--card:#171a21;--line:#262b36;--fg:#e6e8ee;--muted:#8b93a7;--accent:#6ea8ff;--ok:#4cc38a;--warn:#f5a524;--err:#f0616d}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,sans-serif}
main{max-width:760px;margin:0 auto;padding:16px}nav{padding:10px 16px;border-bottom:1px solid var(--line);display:flex;gap:12px;align-items:center}nav a{color:var(--accent);text-decoration:none}nav b{color:var(--muted);font-weight:500}
h1{font-size:22px;margin:0}h3{font-size:12px;letter-spacing:.06em;text-transform:uppercase;color:var(--muted);margin:0 0 8px;font-weight:600}
.strip{display:flex;flex-wrap:wrap;gap:6px 14px;align-items:center;padding:8px 12px;border:1px dashed var(--line);border-radius:10px;font-size:12px;color:var(--muted);background:#12151b}
.strip b{color:var(--fg)}.dot{width:9px;height:9px;border-radius:50%;background:var(--muted)}
.run-running .dot{background:var(--accent);animation:p 1.2s infinite}.run-idle .dot{background:var(--ok)}.run-error .dot{background:var(--err)}
@keyframes p{50%{opacity:.3}}
.flag{margin:6px 0;padding:8px 12px;border-radius:10px;font-size:13px;background:#1b1e26;border:1px solid var(--line)}.sev-warn{border-color:var(--warn);color:#ffd9a0}.sev-error{border-color:var(--err);color:#ffb3ba}.sev-info{border-color:var(--accent)}
.canvas{margin-top:14px}.canvas.dim{opacity:.45;filter:grayscale(.6)}.canvas header{display:flex;gap:10px;align-items:center;margin-bottom:10px;flex-wrap:wrap}
.tag{font-size:11px;padding:2px 8px;border-radius:99px;border:1px solid var(--line);color:var(--muted)}.st-done{color:var(--ok);border-color:var(--ok)}.st-blocked{color:var(--err);border-color:var(--err)}.st-waiting{color:var(--warn);border-color:var(--warn)}
.blocks{display:flex;flex-direction:column;gap:10px}.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:12px 14px}
.bluf{font-size:17px;margin:4px 0}.muted{color:var(--muted)}.mono{font-family:ui-monospace,monospace;text-transform:none;letter-spacing:0}
.steps{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:6px}.step{display:flex;gap:10px}.step .ic{width:18px;text-align:center}
.step.done .ic{color:var(--ok)}.step.active .ic{color:var(--accent)}.step.active{font-weight:600}.step.failed .ic{color:var(--err)}.step.pending,.step.skipped{color:var(--muted)}
.progress .pl{display:flex;justify-content:space-between;font-size:13px;color:var(--muted)}.bar{height:8px;background:var(--line);border-radius:99px;overflow:hidden}.bar i{display:block;height:100%;background:var(--accent)}
.metrics{display:flex;flex-wrap:wrap;gap:8px}.metric{display:inline-flex;flex-direction:column;background:var(--card);border:1px solid var(--line);border-radius:12px;padding:8px 14px}.metric small{color:var(--muted)}.metric b{font-size:20px}
.tone-warn b,.tone-warn{color:var(--warn)}.tone-error b,.tone-error{color:var(--err)}.tone-success b,.tone-success{color:var(--ok)}
.note{margin:0;padding:8px 12px;border-radius:10px;background:var(--card);border-left:3px solid var(--accent)}.note.tone-warn{border-color:var(--warn)}.note.tone-error{border-color:var(--err)}.note.tone-success{border-color:var(--ok)}
.chosen{margin:0 0 4px;font-weight:600}.q{margin:0 0 10px;font-size:16px}.opts{display:flex;gap:8px;flex-wrap:wrap}
.opt{font:inherit;padding:8px 16px;border-radius:99px;border:1px solid var(--accent);background:transparent;color:var(--accent);cursor:pointer}button.opt:hover{background:var(--accent);color:#000}
.opt.picked{background:var(--ok);color:#000;border-color:var(--ok)}.opt.off{opacity:.4;border-color:var(--line);color:var(--muted)}.ask.open{border-color:var(--accent)}
pre{margin:0;overflow:auto;font:12px/1.5 ui-monospace,monospace}.diff .add{color:var(--ok);display:inline-block;width:100%;background:#4cc38a14}.diff .del{color:var(--err);display:inline-block;width:100%;background:#f0616d14}.diff .hunk{color:var(--muted)}
table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:5px 8px;border-bottom:1px solid var(--line)}th{color:var(--muted);font-size:12px}
.chart svg{width:100%;max-width:360px}.chart figcaption{color:var(--muted);font-size:12px}a{color:var(--accent)}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:12px}.tile{display:block;background:var(--card);border:1px solid var(--line);border-radius:12px;padding:12px 14px;color:inherit;text-decoration:none}.tile.dim{opacity:.5}
.tile .tt{display:flex;justify-content:space-between;gap:8px}.tile p{margin:6px 0;color:var(--fg)}.tile small{color:var(--muted)}.tile em{display:block;margin-top:6px;font-style:normal;font-size:12px;color:var(--warn)}
.pill{font-size:11px;padding:2px 8px;border-radius:99px;border:1px solid var(--line);color:var(--muted);height:fit-content}
.verdict-needs-you{border-color:var(--accent)}.verdict-needs-you .pill{color:var(--accent);border-color:var(--accent)}.verdict-disputed,.verdict-stale{border-color:var(--warn)}.verdict-disputed .pill,.verdict-stale .pill{color:var(--warn);border-color:var(--warn)}.verdict-error{border-color:var(--err)}.verdict-error .pill{color:var(--err);border-color:var(--err)}.verdict-done .pill{color:var(--ok);border-color:var(--ok)}
`;

const SCRIPT = `
const root=document.getElementById('root');const url=root.dataset.frag;
async function tick(){try{const r=await fetch(url,{cache:'no-store'});if(r.ok){const h=await r.text();if(h!==root.dataset.last){root.innerHTML=h;root.dataset.last=h}}}catch(e){}}
setInterval(tick,1500);tick();
document.addEventListener('click',async e=>{const b=e.target.closest('button.opt');if(!b)return;b.disabled=true;b.textContent+=' …';
const r=await fetch('/api/answer',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({agentId:b.dataset.agent,askId:b.dataset.ask,value:b.dataset.value})});
const j=await r.json().catch(()=>({}));if(!j.ok)alert(j.error||'failed');tick();});
`;

export function page(title: string, body: string, frag: string, crumbs = ""): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><style>${CSS}</style></head><body><nav><a href="/">Canvases</a>${crumbs}<b style="margin-left:auto">agent-canvas demo</b></nav><main><div id="root" data-frag="${esc(frag)}" data-last="">${body}</div></main><script>${SCRIPT}</script></body></html>`;
}
