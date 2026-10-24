// The browser stylesheet, re-scoped so another page can inline it next to its own: every rule is prefixed with
// `.acv`, :root/html/body become `.acv`, and the dark-mode media queries follow an explicit theme when one is asked for.
import { COMPONENT_CSS, cssVars } from "./ui-html.ts";

/** Split on commas that are not inside (), [] or a string. */
function splitSelectors(s: string): string[] {
  const out: string[] = [];
  let depth = 0, start = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === "(" || ch === "[") depth++;
    else if (ch === ")" || ch === "]") depth--;
    else if (ch === "," && depth === 0) { out.push(s.slice(start, i)); start = i + 1; }
  }
  out.push(s.slice(start));
  return out.map((x) => x.trim()).filter(Boolean);
}

export function scopeCss(css: string, scope: string, theme?: "light" | "dark"): string {
  let out = "";
  let i = 0;
  while (i < css.length) {
    const open = css.indexOf("{", i);
    if (open < 0) break;
    let depth = 1, j = open + 1;
    while (j < css.length && depth > 0) { if (css[j] === "{") depth++; else if (css[j] === "}") depth--; j++; }
    const prelude = css.slice(i, open).trim();
    const inner = css.slice(open + 1, j - 1);
    i = j;
    if (prelude.startsWith("@keyframes") || prelude.startsWith("@font-face")) out += `${prelude}{${inner}}`;
    else if (prelude.startsWith("@")) {
      if (/prefers-color-scheme\s*:\s*dark/.test(prelude) && theme) { if (theme === "dark") out += scopeCss(inner, scope, theme); }
      else out += `${prelude}{${scopeCss(inner, scope, theme)}}`;
    } else {
      const sels = splitSelectors(prelude).map((s) => (s === ":root" || s === "html" || s === "body" ? scope : s === "*" ? `${scope},${scope} *` : `${scope} ${s}`));
      out += `${sels.join(",")}{${inner}}`;
    }
  }
  return out;
}

/** The whole stylesheet for the embedded card: variables, then components. */
export function fmCss(theme?: "light" | "dark"): string {
  const t = theme ? `.acv{color-scheme:${theme}}` : "";
  return scopeCss(cssVars() + COMPONENT_CSS, ".acv", theme) + t;
}
