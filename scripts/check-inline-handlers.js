const fs = require('fs');
const path = require('path');

const BUILTIN = new Set([
  'if','for','while','return','parseInt','parseFloat','Number','String','Boolean','Array','Object',
  'JSON','Math','alert','confirm','prompt','require','fetch','decodeURIComponent','encodeURIComponent',
  'setTimeout','setInterval',  'isNaN','eval','this','event','e','fn',
  // Method calls (không phải function reference): el.remove(), e.preventDefault(), ...
  'remove','add','replace','open','preventDefault','stopPropagation','stopImmediatePropagation',
  'blur','focus','click','submit','reset','scrollIntoView','getAttribute','setAttribute',
  'hasAttribute','removeAttribute','closest','contains','appendChild','removeChild','insertBefore',
]);

const HANDLER_RE = /(?:onclick|onchange|onsubmit|oninput|onkeyup|onkeydown|onblur|onfocus|onload)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
const EXPORT_RE = /window\.([A-Za-z_$][A-Za-z0-9_$]*)\s*=/g;
const FUNC_DEF_RE = /(?:^|\s)function\s+([A-Za-z_$][A-Za-z0-9_$]*)/g;
const VAR_DECL_RE = /(?:^|\s)(?:const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=/g;

function collect(files) {
  const exported = new Set();
  const defined = new Set();
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8');
    let m;
    while ((m = EXPORT_RE.exec(src))) exported.add(m[1]);
    while ((m = FUNC_DEF_RE.exec(src))) defined.add(m[1]);
    while ((m = VAR_DECL_RE.exec(src))) defined.add(m[1]);
  }
  return { exported, defined };
}

let exitCode = 0;
for (const htmlFile of process.argv.slice(2)) {
  const html = fs.readFileSync(htmlFile, 'utf8');

  // JS files referenced by this HTML (script src + dynamic loadScript())
  const dir = path.dirname(htmlFile);
  const jsRefs = [
    ...[...html.matchAll(/<script[^>]*src=["']([^"']+)["']/g)].map((m) => m[1]),
    ...[...html.matchAll(/loadScript\(\s*["']([^"']+)["']/g)].map((m) => m[1]),
  ];
  const jsFiles = [];
  for (const ref of jsRefs) {
    if (/^(https?:)?\/\//.test(ref) || ref.startsWith('//')) continue;
    const clean = ref.split('?')[0].replace(/^\//, '');
    const candidates = [
      path.join(dir, clean),
      path.join(process.cwd(), 'public', clean),
    ];
    for (const c of candidates) {
      if (fs.existsSync(c)) { jsFiles.push(c); break; }
    }
  }

  const { exported, defined } = collect([htmlFile, ...jsFiles]);

  const used = new Set();
  let m;
  const handlerRe = new RegExp(HANDLER_RE.source, 'g');
  while ((m = handlerRe.exec(html))) {
    const code = m[1] || m[2] || '';
    const callRe = /([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/g;
    let c;
    while ((c = callRe.exec(code))) used.add(c[1]);
  }

  const missing = [...used].filter(
    (n) => !exported.has(n) && !defined.has(n) && !BUILTIN.has(n)
  );
  if (missing.length) {
    exitCode = 1;
    console.log(`${path.basename(htmlFile)}: MISSING -> ${missing.join(', ')}`);
  }
}
process.exit(exitCode);
