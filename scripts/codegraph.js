#!/usr/bin/env node
// Codebase graph producer and consumer with commit-keyed enforced freshness.
// update: build or refresh the graph for an explicit repo root (incremental).
// status: read-only freshness report. Exit 0 FRESH, 3 STALE, 4 no graph.
// map: emit the ranked symbol map. REFUSES when stale unless --allow-stale,
// so an unlabeled stale map is impossible to consume.
// Run: node scripts/codegraph.js <update|status|map> --root <repo-root>
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const LANGS = {
  '.js': 'js', '.mjs': 'js', '.cjs': 'js', '.jsx': 'js',
  '.ts': 'ts', '.tsx': 'ts', '.py': 'py'
};
// Vendored or generated trees add noise without structure signal
const SKIP_PATH = /(^|\/)(node_modules|vendor|vendored|third_party|dist|build)\/|\.min\.(js|css)$/;
// Language keywords stored as refs would bloat the cache with zero ranking value
const STOPWORDS = new Set([
  'function', 'return', 'const', 'class', 'import', 'export', 'from',
  'default', 'async', 'await', 'this', 'self', 'None', 'True', 'False',
  'null', 'undefined', 'true', 'false', 'def', 'pass', 'raise', 'lambda',
  'new', 'var', 'let', 'typeof', 'instanceof', 'require', 'module',
  'exports', 'else', 'elif', 'while', 'for', 'continue', 'break', 'try',
  'except', 'catch', 'finally', 'with', 'yield', 'not', 'and', 'or', 'in',
  'is', 'if', 'then', 'switch', 'case', 'delete', 'void', 'extends',
  'super', 'static', 'get', 'set', 'interface', 'type', 'enum', 'string',
  'number', 'boolean', 'object', 'public', 'private', 'protected'
]);
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const CHARS_PER_TOKEN = 3.5;
const REBUILD_CMD = root => 'node scripts/codegraph.js update --root ' + root;

function parseArgs(argv) {
  const out = { cmd: argv[0], allowStale: false };
  for (let i = 1; i < argv.length; i++) {
    if (argv[i] === '--root') out.root = argv[++i];
    else if (argv[i] === '--budget') out.budget = parseInt(argv[++i], 10);
    else if (argv[i] === '--allow-stale') out.allowStale = true;
  }
  return out;
}

function graphPath() {
  return path.join(process.env.COMPANY_DIR || './.company', 'codegraph', 'graph.json');
}

function git(root, args, opts) {
  return execFileSync('git', ['-C', root].concat(args),
    Object.assign({ encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }, opts || {}));
}

function loadGraph(forRoot) {
  // Corrupt cache degrades to a full rebuild, never to a crash
  try {
    const g = JSON.parse(fs.readFileSync(graphPath(), 'utf8'));
    // A graph built for another root proves nothing about this one
    if (forRoot && g.root !== path.resolve(forRoot)) return null;
    return g;
  }
  catch (e) { return null; }
}

function extractSymbols(lang, content) {
  const symbols = [];
  const seen = new Set();
  const add = (name, kind) => {
    if (name && name.length >= 3 && !STOPWORDS.has(name) && !seen.has(name)) {
      seen.add(name);
      symbols.push({ name: name, kind: kind });
    }
  };
  const lines = content.split('\n');
  for (const line of lines) {
    let m;
    if (lang === 'py') {
      if ((m = line.match(/^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)/))) add(m[1], 'fn');
      if ((m = line.match(/^\s*class\s+([A-Za-z_]\w*)/))) add(m[1], 'class');
      if ((m = line.match(/^([A-Z][A-Z0-9_]{2,})\s*[:=]/))) add(m[1], 'const');
    } else {
      if ((m = line.match(/(?:^|\s)function\s+([A-Za-z_$][\w$]*)/))) add(m[1], 'fn');
      if ((m = line.match(/(?:^|\s)class\s+([A-Za-z_$][\w$]*)/))) add(m[1], 'class');
      if ((m = line.match(/^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/))) add(m[1], 'const');
      if ((m = line.match(/(?:module\.)?exports\.([A-Za-z_$][\w$]*)\s*=/))) add(m[1], 'export');
      if (lang === 'ts' && (m = line.match(/^\s*(?:export\s+)?(?:interface|type|enum)\s+([A-Za-z_$][\w$]*)/))) add(m[1], 'type');
    }
  }
  return symbols;
}

function countIdents(content) {
  const refs = {};
  const re = /[A-Za-z_$][A-Za-z0-9_$]{2,}/g;
  let m;
  while ((m = re.exec(content))) {
    if (!STOPWORDS.has(m[0])) refs[m[0]] = (refs[m[0]] || 0) + 1;
  }
  return refs;
}

function update(root, budget) {
  const t0 = Date.now();
  let commit;
  try { commit = git(root, ['rev-parse', 'HEAD']).trim(); }
  catch (e) {
    console.error('codegraph: ' + root + ' is not a git repository (or has no commits). Pass an explicit repo root.');
    process.exit(2);
  }
  const tracked = git(root, ['ls-files', '-z'], { maxBuffer: 64 * 1024 * 1024 }).split('\0').filter(Boolean);
  const prev = loadGraph();
  const prevFiles = (prev && prev.root === path.resolve(root) && prev.files) || {};
  const files = {};
  let reused = 0, parsed = 0, skipped = 0;
  for (const rel of tracked) {
    const lang = LANGS[path.extname(rel)];
    if (!lang || SKIP_PATH.test(rel)) { skipped++; continue; }
    const abs = path.join(root, rel);
    let st;
    try { st = fs.statSync(abs); } catch (e) { continue; }
    if (st.size > MAX_FILE_BYTES) { skipped++; continue; }
    const old = prevFiles[rel];
    if (old && old.mtime === st.mtimeMs && old.size === st.size) {
      files[rel] = old;
      reused++;
      continue;
    }
    const content = fs.readFileSync(abs, 'utf8');
    if (content.indexOf('\0') !== -1) { skipped++; continue; }
    files[rel] = {
      mtime: st.mtimeMs, size: st.size, lang: lang,
      symbols: extractSymbols(lang, content),
      refs: countIdents(content)
    };
    parsed++;
  }
  const graph = {
    version: 1,
    root: path.resolve(root),
    built_at: Math.floor(Date.now() / 1000),
    built_at_commit: commit,
    default_budget: budget || (prev && prev.default_budget) || 1500,
    files: files
  };
  const gp = graphPath();
  fs.mkdirSync(path.dirname(gp), { recursive: true });
  fs.writeFileSync(gp, JSON.stringify(graph));
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  const nsyms = Object.values(files).reduce((a, f) => a + f.symbols.length, 0);
  console.log('codegraph: built ' + gp + ' in ' + secs + 's at commit ' + commit.slice(0, 7) +
    ' (' + Object.keys(files).length + ' files indexed, ' + nsyms + ' symbols, ' +
    parsed + ' parsed, ' + reused + ' cached, ' + skipped + ' skipped)');
}

function freshness(root, graph) {
  let localOnly = false;
  try { git(root, ['fetch', 'origin', '--quiet'], { timeout: 30000 }); }
  catch (e) { localOnly = true; }
  let target = 'HEAD';
  if (!localOnly) {
    target = null;
    try {
      target = git(root, ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD']).trim().replace('refs/remotes/', '');
    } catch (e) { /* unset origin/HEAD is common, probe branch names instead */ }
    if (!target) {
      for (const b of ['origin/main', 'origin/master']) {
        try { git(root, ['rev-parse', '--verify', '--quiet', b]); target = b; break; }
        catch (e) { /* try the next candidate branch */ }
      }
    }
    if (!target) { localOnly = true; target = 'HEAD'; }
  }
  let changed = null, behind = null;
  try {
    behind = parseInt(git(root, ['rev-list', '--count', graph.built_at_commit + '..' + target]).trim(), 10);
    changed = git(root, ['diff', '--name-only', graph.built_at_commit + '..' + target]).split('\n').filter(Boolean);
  } catch (e) { /* unknown built commit means the graph cannot prove freshness */ }
  const dirty = git(root, ['status', '--porcelain']).split('\n')
    .filter(l => l && !l.startsWith('??'))
    .map(l => l.slice(3).trim());
  if (changed === null) return { stale: true, n: '?', m: '?', localOnly: localOnly };
  const union = new Set(changed.concat(dirty));
  return { stale: union.size > 0 || behind > 0, n: union.size, m: behind, localOnly: localOnly };
}

function staleLabel(f) {
  return 'STALE(' + f.n + ' files, ' + f.m + ' commits behind)' + (f.localOnly ? ' LOCAL-ONLY' : '');
}

function status(root) {
  const graph = loadGraph(root);
  if (!graph) {
    console.log('NO-GRAPH: ' + graphPath() + ' missing. Build it: ' + REBUILD_CMD(root));
    process.exit(4);
  }
  const f = freshness(root, graph);
  if (f.stale) {
    console.log(staleLabel(f) + '. Rebuild: ' + REBUILD_CMD(root));
    process.exit(3);
  }
  console.log('FRESH at commit ' + graph.built_at_commit.slice(0, 7) +
    ' (' + Object.keys(graph.files).length + ' files indexed)' + (f.localOnly ? ' LOCAL-ONLY' : ''));
  process.exit(0);
}

function rankFiles(graph) {
  const files = graph.files;
  const names = Object.keys(files);
  // Names defined in many files (response, data, result) carry no structure
  // signal, so a symbol's refs are discounted by its definition count
  const defCount = {};
  for (const rel of names) {
    for (const s of files[rel].symbols) defCount[s.name] = (defCount[s.name] || 0) + 1;
  }
  const ranked = [];
  for (const rel of names) {
    const syms = [];
    for (const s of files[rel].symbols) {
      let refs = 0;
      for (const other of names) {
        if (other !== rel) refs += files[other].refs[s.name] || 0;
      }
      refs = Math.round(refs / defCount[s.name]);
      syms.push({ name: s.name, kind: s.kind, refs: refs });
    }
    syms.sort((a, b) => b.refs - a.refs);
    const score = syms.reduce((a, s) => a + s.refs, 0);
    ranked.push({ rel: rel, score: score, syms: syms });
  }
  ranked.sort((a, b) => b.score - a.score);
  return ranked;
}

function map(root, budget, allowStale) {
  const graph = loadGraph(root);
  if (!graph) {
    console.log('NO-GRAPH: ' + graphPath() + ' missing. Build it: ' + REBUILD_CMD(root));
    process.exit(4);
  }
  const f = freshness(root, graph);
  if (f.stale && !allowStale) {
    // Fresh-or-labeled is the invariant: a stale map never emits unlabeled
    console.log(staleLabel(f) + ': map refused. Rebuild: ' + REBUILD_CMD(root) +
      ' (or pass --allow-stale to get a labeled stale map)');
    process.exit(3);
  }
  const limit = budget || graph.default_budget || 1500;
  const lines = [];
  if (f.stale) lines.push(staleLabel(f) + ' map follows. Rebuild: ' + REBUILD_CMD(root));
  lines.push('CODEGRAPH ' + graph.root + ' @ ' + graph.built_at_commit.slice(0, 7) +
    ' (' + Object.keys(graph.files).length + ' files, budget ' + limit + ' tokens)');
  const ranked = rankFiles(graph);
  let chars = lines.join('\n').length;
  let shown = 0;
  for (const r of ranked) {
    const symsLine = '  ' + r.syms.slice(0, 8)
      .map(s => s.kind + ' ' + s.name + (s.refs ? ' x' + s.refs : '')).join(', ');
    const block = r.rel + '\n' + symsLine;
    // Budget enforced at file boundaries (80 chars reserved for the footer)
    if ((chars + block.length + 81) / CHARS_PER_TOKEN > limit) break;
    lines.push(block);
    chars += block.length + 1;
    shown++;
  }
  lines.push('(' + shown + ' of ' + ranked.length + ' files shown, est ' +
    Math.ceil(chars / CHARS_PER_TOKEN) + ' tokens)');
  console.log(lines.join('\n'));
}

const args = parseArgs(process.argv.slice(2));
if (!args.cmd || !args.root || ['update', 'status', 'map'].indexOf(args.cmd) === -1) {
  console.error('usage: codegraph.js <update|status|map> --root <repo-root> [--budget <tokens>] [--allow-stale]');
  process.exit(2);
}
if (args.cmd === 'update') update(args.root, args.budget);
else if (args.cmd === 'status') status(args.root);
else map(args.root, args.budget, args.allowStale);
