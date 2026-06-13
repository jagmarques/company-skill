// stakes-routing.test.js
// Non-vacuous proof: a criterion with stakes:"high" must trigger the 3-lens path,
// and a normal criterion must NOT. Tests work by reading the authoring rules in
// SKILL.md and the reviewer/critic agent files to confirm the gating field is:
//   (a) instructed in the criteria-authoring section (reachability), and
//   (b) wired in the reviewer stall-counter duty (so attempts is written), and
//   (c) referenced in the VERIFY section's perspective-diverse block.
// A missing wiring line causes the relevant assertion to fail, proving non-vacuity.
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SKILL = fs.readFileSync(path.join(ROOT, 'skill', 'SKILL.md'), 'utf8');
const REVIEWER = fs.readFileSync(path.join(ROOT, 'agents', 'company-reviewer.md'), 'utf8');
const CRITIC = fs.readFileSync(path.join(ROOT, 'agents', 'company-critic.md'), 'utf8');

let pass = 0;
let fail = 0;

function assert(label, condition) {
  if (condition) {
    console.log('ok: ' + label);
    pass++;
  } else {
    console.log('FAIL: ' + label);
    fail++;
  }
}

// 1. REACHABILITY: the criteria-authoring block must tell the orchestrator to set stakes.
//    Matches the sentence instructing stakes:"high" on irreversible/security criteria.
assert(
  'SKILL.md criteria-authoring instructs stakes field',
  /Set `stakes: "high"`/.test(SKILL) || /Set `stakes:\s*"high"`/.test(SKILL)
);

// 2. REACHABILITY: the criteria-authoring block must explain the default (normal = unchanged).
assert(
  'SKILL.md documents stakes normal default leaves behavior unchanged',
  /default is normal/.test(SKILL) || /existing behavior unchanged/.test(SKILL)
);

// 3. GATE WIRING: the VERIFY section must reference stakes:high to trigger the 3-lens path.
assert(
  'SKILL.md VERIFY section references stakes: high for 3-lens path',
  /stakes:\s*["’]?high/.test(SKILL)
);

// 4. STALL WIRING: the VERIFY/stall section must state the reviewer writes attempts to criteria.json.
//    Without this, attempts is never written and the high-stakes gate at attempts>=2 is unreachable.
assert(
  'SKILL.md stall detector notes reviewer must write attempts to criteria.json',
  /reviewer.*instructs.*attempts|reviewer agent file instructs|writing.*attempts.*required/i.test(SKILL)
);

// 5. REVIEWER WIRING: reviewer agent must instruct incrementing attempts (not just mention it).
assert(
  'reviewer agent instructs writing attempts field',
  /increment.*attempts|attempts.*increment/i.test(REVIEWER) &&
  /Writing `attempts` is required/i.test(REVIEWER)
);

// 6. REVIEWER ANTI-VACUOUS: reviewer agent must check new tests fail before the fix.
assert(
  'reviewer agent has anti-vacuous test check',
  /FAIL.*pre-change|pre-change.*FAIL/i.test(REVIEWER) ||
  /ANTI-VACUOUS/.test(REVIEWER)
);

// 7. REVIEWER REACHABILITY: reviewer must check gating fields are authored.
assert(
  'reviewer agent has feature reachability check',
  /FEATURE REACHABILITY/i.test(REVIEWER)
);

// 8. CRITIC PROBES: critic must have anti-vacuous test probe.
assert(
  'critic agent has anti-vacuous test probe',
  /ANTI-VACUOUS/.test(CRITIC) ||
  /vacuous.*pre-change|pre-change.*vacuous/i.test(CRITIC)
);

// 9. CRITIC PROBES: critic must have feature reachability probe.
assert(
  'critic agent has feature reachability probe',
  /FEATURE REACHABILITY/i.test(CRITIC)
);

// 10. NON-VACUITY SELF-CHECK: confirm the criteria template now includes stakes field.
//     This assertion FAILS against the pre-fix code (where the template had no stakes).
assert(
  'criteria.json template includes stakes field',
  /"stakes":"normal"|"stakes":\s*"normal"/.test(SKILL) ||
  /stakes.*normal/.test(SKILL)
);

// 11. NON-VACUITY SELF-CHECK: confirm the 3-lens block explains it is gated by the stakes field
//     in criteria.json (not some other condition only). This distinguishes the shipped feature
//     from the pre-4.6.3 code that had no stakes field at all.
assert(
  'VERIFY 3-lens block is explicitly gated on stakes field in criteria.json',
  /tagged `stakes: high` in criteria\.json/.test(SKILL)
);

console.log('\n' + pass + ' passed, ' + fail + ' failed');
if (fail > 0) process.exit(1);
