/**
 * serve-report.ts - Minimal local server for the learning report.
 *
 *   bun scripts/serve-report.ts [--port 7777] [--file <path.md>]
 *
 * Renders the markdown client-side with marked (CDN) — no dependencies.
 */
import { existsSync } from "fs";

const args = process.argv.slice(2);
const flag = (name: string, fallback: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const PORT = Number(flag("port", "7777"));
const FILE = flag(
  "file",
  `${process.env.HOME}/zero8.dev/BUILDER-RETROSPECTIVE-2026-FEB-JUN.md`
);

if (!existsSync(FILE)) {
  console.error(`Report not found: ${FILE}`);
  process.exit(1);
}

const SHELL = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Builder Retrospective — Feb–Jun 2026</title>
<script src="https://cdn.jsdelivr.net/npm/marked@12/marked.min.js"></script>
<style>
  :root { color-scheme: light dark; }
  body { max-width: 76ch; margin: 2rem auto; padding: 0 1.25rem 6rem;
         font: 16px/1.65 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
  h1, h2 { line-height: 1.25; }
  h2 { margin-top: 2.5em; border-bottom: 1px solid color-mix(in srgb, currentColor 20%, transparent); padding-bottom: .3em; }
  h3 { margin-top: 1.8em; }
  hr { border: none; border-top: 1px solid color-mix(in srgb, currentColor 15%, transparent); margin: 2.5em 0; }
  code { background: color-mix(in srgb, currentColor 8%, transparent); padding: .1em .35em; border-radius: 4px; font-size: .9em; }
  pre code { display: block; padding: 1em; overflow-x: auto; }
  blockquote { border-left: 3px solid color-mix(in srgb, currentColor 25%, transparent); margin-left: 0; padding-left: 1em; opacity: .85; }
  nav { font-size: .85em; opacity: .75; margin-bottom: 2rem; }
</style>
</head>
<body>
<nav>local · <a href="/raw">raw markdown</a></nav>
<main id="app">Loading…</main>
<script>
  fetch("/raw").then(r => r.text()).then(md => {
    document.getElementById("app").innerHTML = marked.parse(md, { mangle: false, headerIds: true });
    document.title = document.querySelector("h1")?.textContent || document.title;
  });
</script>
</body>
</html>`;

Bun.serve({
  port: PORT,
  hostname: "127.0.0.1",
  async fetch(req) {
    const { pathname } = new URL(req.url);
    if (pathname === "/raw") {
      return new Response(await Bun.file(FILE).text(), {
        headers: { "content-type": "text/markdown; charset=utf-8" },
      });
    }
    if (pathname === "/" || pathname === "/index.html") {
      return new Response(SHELL, {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }
    return new Response("Not found", { status: 404 });
  },
});

console.log(`Serving ${FILE}`);
console.log(`→ http://127.0.0.1:${PORT}`);
