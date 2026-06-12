#!/usr/bin/env node
// Decision tests for scripts/codegraph.js: symbol extraction, ranking,
// budget enforcement, and the refuse-or-label staleness contract.
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const SCRIPT = path.join(__dirname, '..', 'scripts', 'codegraph.js');
let failures = 0, n = 0;

function check(name, ok, detail) {
  n += 1;
  if (ok) console.log('ok: case ' + n + ' ' + name);
  else { console.log('FAIL case ' + n + ' (' + name + '): ' + (detail || '')); failures += 1; }
}

function sh(cwd, cmd, args) {
  execFileSync(cmd, args, { cwd: cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function run(args, stateDir) {
  const env = Object.assign({}, process.env, { COMPANY_DIR: stateDir });
  try {
    const out = execFileSync(process.execPath, [SCRIPT].concat(args), { encoding: 'utf8', env: env });
    return { status: 0, out: out };
  } catch (e) {
    return { status: e.status, out: (e.stdout || '') + (e.stderr || '') };
  }
}

// Fixture: a real git repo where core symbols are referenced by other files
const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-repo-'));
const state = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-state-'));
sh(repo, 'git', ['init', '-q']);
sh(repo, 'git', ['config', 'user.email', 'test@example.com']);
sh(repo, 'git', ['config', 'user.name', 'test']);
fs.writeFileSync(path.join(repo, 'core.py'),
  'def central_helper(x):\n    return x\n\nclass CoreEngine:\n    def run_pipeline(self):\n        pass\n');
fs.writeFileSync(path.join(repo, 'app.py'),
  'engine = CoreEngine()\nfor i in range(3):\n    central_helper(i)\ncentral_helper(engine)\nCoreEngine()\n');
fs.writeFileSync(path.join(repo, 'util.js'),
  'function centralHelper(x) { return x; }\nconst sharedThing = 1;\nmodule.exports.centralHelper = centralHelper;\n');
fs.writeFileSync(path.join(repo, 'main.js'),
  'const u = require("./util");\nu.centralHelper(1);\nu.centralHelper(2);\nconsole.log(u.sharedThing);\n');
fs.writeFileSync(path.join(repo, 'lonely.py'), 'def unused_thing():\n    pass\n');
fs.writeFileSync(path.join(repo, 'blob.py'), Buffer.from([0x64, 0x65, 0x66, 0x00, 0x01, 0x02]));
sh(repo, 'git', ['add', '.']);
sh(repo, 'git', ['commit', '-q', '-m', 'fixture']);

// 1. status before any build reports no graph with exit 4
let r = run(['status', '--root', repo], state);
check('status without graph exits 4', r.status === 4 && r.out.includes('NO-GRAPH'), r.out);

// 2. update builds the graph
r = run(['update', '--root', repo], state);
const graphFile = path.join(state, 'codegraph', 'graph.json');
check('update builds graph.json', r.status === 0 && fs.existsSync(graphFile), r.out);

// 3. symbol extraction found the fixture defs across languages
const graph = JSON.parse(fs.readFileSync(graphFile, 'utf8'));
const names = f => (graph.files[f] || { symbols: [] }).symbols.map(s => s.name);
check('py def extracted', names('core.py').includes('central_helper'));
check('py class extracted', names('core.py').includes('CoreEngine'));
check('js function extracted', names('util.js').includes('centralHelper'));
check('js const extracted', names('util.js').includes('sharedThing'));
check('binary content skipped', !graph.files['blob.py'], JSON.stringify(Object.keys(graph.files)));

// 4. status on a fresh graph is FRESH, exit 0, LOCAL-ONLY without a remote
r = run(['status', '--root', repo], state);
check('status fresh exits 0', r.status === 0 && r.out.includes('FRESH'), r.out);
check('no remote stamps LOCAL-ONLY', r.out.includes('LOCAL-ONLY'), r.out);

// 5. ranking: the referenced core file outranks the unreferenced one
r = run(['map', '--root', repo], state);
check('map emits on fresh graph', r.status === 0, r.out);
const iCore = r.out.indexOf('core.py'), iLonely = r.out.indexOf('lonely.py');
check('referenced file ranks above unreferenced', iCore !== -1 && (iLonely === -1 || iCore < iLonely), r.out);

// 6. budget enforcement: emitted chars stay inside the token budget
r = run(['map', '--root', repo, '--budget', '100'], state);
check('map within budget', r.status === 0 && r.out.length / 3.5 <= 100, 'chars=' + r.out.length);
const rBig = run(['map', '--root', repo, '--budget', '5000'], state);
check('larger budget shows at least as much', rBig.out.length >= r.out.length);

// 7. a new commit flips status to STALE with exit 3
fs.appendFileSync(path.join(repo, 'core.py'), '\ndef late_addition():\n    pass\n');
sh(repo, 'git', ['add', '.']);
sh(repo, 'git', ['commit', '-q', '-m', 'change']);
r = run(['status', '--root', repo], state);
check('status stale exits 3', r.status === 3 && r.out.includes('STALE('), r.out);

// 8. map REFUSES when stale: exit 3 plus the rebuild command
r = run(['map', '--root', repo], state);
check('stale map refused with exit 3', r.status === 3 && r.out.includes('refused'), r.out);
check('refusal prints rebuild command', r.out.includes('update --root'), r.out);

// 9. --allow-stale emits with a first-line STALE banner
r = run(['map', '--root', repo, '--allow-stale'], state);
check('allow-stale emits exit 0', r.status === 0, r.out);
check('allow-stale banner is first line', r.out.split('\n')[0].startsWith('STALE('), r.out.split('\n')[0]);

// 10. update restores FRESH
r = run(['update', '--root', repo], state);
r = run(['status', '--root', repo], state);
check('update restores FRESH', r.status === 0 && r.out.includes('FRESH'), r.out);

// 11. uncommitted tracked changes also count as stale
fs.appendFileSync(path.join(repo, 'app.py'), 'central_helper(9)\n');
r = run(['status', '--root', repo], state);
check('dirty working tree is stale', r.status === 3 && r.out.includes('STALE('), r.out);
sh(repo, 'git', ['checkout', '-q', '--', 'app.py']);

// 12. corrupt cache fails soft into a full rebuild
fs.writeFileSync(graphFile, 'not json at all');
r = run(['update', '--root', repo], state);
check('corrupt cache rebuilds', r.status === 0 && fs.existsSync(graphFile), r.out);

// 13. a non-repo root exits nonzero with a clear message
const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-plain-'));
r = run(['update', '--root', plain], state);
check('non-repo root rejected', r.status !== 0 && r.out.includes('not a git repository'), r.out);

fs.rmSync(repo, { recursive: true, force: true });
fs.rmSync(state, { recursive: true, force: true });
fs.rmSync(plain, { recursive: true, force: true });
if (failures) { console.log('CODEGRAPH TESTS FAILED: ' + failures); process.exit(1); }
console.log('ALL CODEGRAPH TESTS PASSED (' + n + ' checks)');
