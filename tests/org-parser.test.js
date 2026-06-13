#!/usr/bin/env node
// Non-vacuous tests for the COMPANY.md org-tree parser (parseCompanyMd).
// BUG #2: HTML-commented blocks and non-roster sections (Rules, Priorities)
//         must not appear as departments.
// BUG #3: "(Lead: Role)" heading convention and "Lead: Name" bullet form
//         must both resolve to the correct lead name, not "Lead".
//
// Each test calls the parser via a thin harness that patches the file-read
// to return controlled input. Tests MUST fail against the pre-fix code.

'use strict';
const path = require('path');
const fs = require('fs');
const os = require('os');

// ---- inline parseCompanyMd extracted from dashboard.js ----
// We import the logic directly by requiring dashboard.js in a way that exposes
// the function. Since dashboard.js is not a module, we eval a trimmed version.
// Read dashboard.js, extract the function, and eval it in isolation.
const dashSrc = fs.readFileSync(
  path.join(__dirname, '..', 'scripts', 'dashboard.js'),
  'utf8'
);

// Extract NON_ROSTER_SECTIONS + parseCompanyMd from the source.
// We replace the cachedReadFile call with a direct fs.readFileSync so we can
// inject test input via a temp file, and stub COMPANY_DIR to /nonexistent.
const HARNESS_PREFIX = `
'use strict';
const fs = require('fs');
const path = require('path');
const COMPANY_DIR = '/nonexistent-stub-dir';
function cachedReadFile(p) {
  try { return fs.readFileSync(p, 'utf8'); } catch (_) { return null; }
}
`;

// Pull just the NON_ROSTER_SECTIONS const + parseCompanyMd function.
const sectionMatch = dashSrc.match(
  /(const NON_ROSTER_SECTIONS[\s\S]+?^function parseCompanyMd\(\)[\s\S]+?^})/m
);
if (!sectionMatch) {
  console.error('FAIL: could not locate parseCompanyMd in dashboard.js');
  process.exit(1);
}

const parserSrc = HARNESS_PREFIX + sectionMatch[1] + '\nmodule.exports = { parseCompanyMd };';
const tmpFile = path.join(os.tmpdir(), 'parser-harness-' + process.pid + '.js');
fs.writeFileSync(tmpFile, parserSrc);
let parseCompanyMd;
try {
  parseCompanyMd = require(tmpFile).parseCompanyMd;
} catch (e) {
  console.error('FAIL: could not load parser harness: ' + e.message);
  process.exit(1);
}

let failures = 0;
let caseNo = 0;

function check(name, got, expected) {
  caseNo += 1;
  const ok = JSON.stringify(got) === JSON.stringify(expected);
  if (ok) {
    console.log('ok: case ' + caseNo + ' ' + name);
  } else {
    console.log('FAIL case ' + caseNo + ' (' + name + ')');
    console.log('  expected: ' + JSON.stringify(expected));
    console.log('  got:      ' + JSON.stringify(got));
    failures += 1;
  }
}

// Write a COMPANY.md to a temp file and parse it.
function parse(text) {
  const tmp = path.join(os.tmpdir(), 'company-md-test-' + process.pid + '-' + (caseNo + 1) + '.md');
  fs.writeFileSync(tmp, text);
  // Patch path.resolve so the parser finds our temp file.
  const origResolve = path.resolve.bind(path);
  path.resolve = (p) => (p === 'COMPANY.md' ? tmp : origResolve(p));
  try {
    return parseCompanyMd();
  } finally {
    path.resolve = origResolve;
    try { fs.unlinkSync(tmp); } catch (_) {}
  }
}

// ----------------------------------------------------------------
// BUG #2 case A: HTML-commented sections must not appear as departments.
// Pre-fix: "Marketing", "Finance", "Legal" from the comment block all appear.
// Post-fix: zero departments from commented content.
// ----------------------------------------------------------------
{
  const text = [
    '## Engineering (Lead: CTO)',
    '- CTO, technical lead',
    '<!--',
    '## Marketing (Lead: Marketing Lead)',
    '- Marketing Lead, growth',
    '## Finance (Lead: CFO)',
    '- CFO, budget',
    '-->',
  ].join('\n');
  const { departments } = parse(text);
  const names = departments.map(d => d.name);
  check(
    'BUG #2 A: HTML-commented depts are stripped',
    names.includes('Marketing') || names.includes('Finance'),
    false
  );
  check(
    'BUG #2 A: real dept Engineering survives',
    names.includes('Engineering'),
    true
  );
}

// ----------------------------------------------------------------
// BUG #2 case B: ## Rules section (with bullet roles) must not appear.
// Pre-fix: "Rules" appears with bullets parsed as role names.
// Post-fix: no "Rules" department.
// ----------------------------------------------------------------
{
  const text = [
    '## Engineering (Lead: CTO)',
    '- CTO, technical lead',
    '## Rules',
    '- No code ships without QA Lead sign-off',
    '- Security Reviewer must approve anything touching auth',
    '- All findings need at least one reviewer',
  ].join('\n');
  const { departments } = parse(text);
  const names = departments.map(d => d.name);
  check(
    'BUG #2 B: Rules section excluded from departments',
    names.includes('Rules'),
    false
  );
}

// ----------------------------------------------------------------
// BUG #2 case C: ## Priorities section must not appear (numbered bullets).
// Pre-fix: "Priorities" appears. Post-fix: excluded.
// ----------------------------------------------------------------
{
  const text = [
    '## Engineering (Lead: CTO)',
    '- CTO, technical lead',
    '## Priorities',
    '1. [URGENT] First task',
    '2. [IMPORTANT] Second task',
  ].join('\n');
  const { departments } = parse(text);
  const names = departments.map(d => d.name);
  check(
    'BUG #2 C: Priorities section excluded',
    names.includes('Priorities'),
    false
  );
}

// ----------------------------------------------------------------
// BUG #2 case D: parse the actual COMPANY.md.template - must yield
// exactly Engineering, Research, Quality, Product, Scouts (5 real depts).
// Pre-fix: also yields Rules + Marketing + Finance + Legal from the template.
// ----------------------------------------------------------------
{
  const templatePath = path.join(__dirname, '..', 'COMPANY.md.template');
  if (fs.existsSync(templatePath)) {
    const templateText = fs.readFileSync(templatePath, 'utf8');
    const tmp = path.join(os.tmpdir(), 'company-template-test-' + process.pid + '.md');
    fs.writeFileSync(tmp, templateText);
    const origResolve = path.resolve.bind(path);
    path.resolve = (p) => (p === 'COMPANY.md' ? tmp : origResolve(p));
    let departments;
    try {
      ({ departments } = parseCompanyMd());
    } finally {
      path.resolve = origResolve;
      try { fs.unlinkSync(tmp); } catch (_) {}
    }
    const names = departments.map(d => d.name);
    const expectedNames = ['Engineering', 'Research', 'Quality', 'Product', 'Scouts'];
    const phantom = names.filter(n => !expectedNames.includes(n));
    check(
      'BUG #2 D: template yields no phantom departments (Rules/Marketing/Finance/Legal)',
      phantom.length,
      0
    );
    check(
      'BUG #2 D: template yields exactly 5 real departments',
      names.length,
      5
    );
  } else {
    console.log('skip: COMPANY.md.template not found (case D)');
  }
}

// ----------------------------------------------------------------
// BUG #3 case A: "## Dept (Lead: Role)" heading form.
// Pre-fix: lead is determined by first-role heuristic only, so reordering
//          roles would produce the wrong lead. Heading lead is discarded.
// Post-fix: lead matches the role declared in the heading, regardless of order.
// ----------------------------------------------------------------
{
  // QA Lead is listed second but declared as lead in the heading.
  const text = [
    '## Quality (Lead: QA Lead)',
    '- Security Reviewer, vulnerability analysis',
    '- QA Lead, test strategy',
  ].join('\n');
  const { departments } = parse(text);
  const dept = departments.find(d => d.name === 'Quality');
  check(
    'BUG #3 A: heading "(Lead: QA Lead)" wins over first-role heuristic',
    dept && dept.lead && dept.lead.name,
    'QA Lead'
  );
}

// ----------------------------------------------------------------
// BUG #3 case B: "- Lead: Name" bullet form - name must be captured, not "Lead".
// Pre-fix: roleName = "Lead" (stops at colon), real name dropped.
// Post-fix: roleName = the actual name after the colon.
// ----------------------------------------------------------------
{
  const text = [
    '## Growth',
    '- Lead: Ana runs growth',
    '- Bob, does SEO',
  ].join('\n');
  const { departments } = parse(text);
  const dept = departments.find(d => d.name === 'Growth');
  check(
    'BUG #3 B: "Lead: Name" bullet captures the real name, not "Lead"',
    dept && dept.lead && dept.lead.name !== 'Lead',
    true
  );
  check(
    'BUG #3 B: lead name is "Ana"',
    dept && dept.lead && dept.lead.name,
    'Ana'
  );
}

// ----------------------------------------------------------------
// BUG #3 case C: combined - heading declares the lead by role name,
//                that role also appears as a normal bullet (not Lead: form).
//                Verifies heading-lead overrides first-role default.
// ----------------------------------------------------------------
{
  const text = [
    '## Engineering (Lead: CTO)',
    '- CTO, technical decisions',
    '- Backend Developer, API design',
  ].join('\n');
  const { departments } = parse(text);
  const dept = departments.find(d => d.name === 'Engineering');
  check(
    'BUG #3 C: heading "(Lead: CTO)" with CTO as first role still resolves correctly',
    dept && dept.lead && dept.lead.name,
    'CTO'
  );
}

// ----------------------------------------------------------------
// Cleanup temp harness file
// ----------------------------------------------------------------
try { fs.unlinkSync(tmpFile); } catch (_) {}

if (failures === 0) {
  console.log('ALL ' + caseNo + ' ORG-PARSER TESTS PASSED');
  process.exit(0);
} else {
  console.log(failures + '/' + caseNo + ' ORG-PARSER TESTS FAILED');
  process.exit(1);
}
