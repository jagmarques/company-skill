#!/usr/bin/env node
// Non-vacuous tests for D1 (context fill accuracy + model label) and D4 (tree layout overlap).
// Each test must FAIL against pre-fix code and PASS after the fix is applied.

'use strict';

let failures = 0;
let n = 0;

function check(name, got, expected, detail) {
  n += 1;
  if (got === expected) {
    console.log('ok: case ' + n + ' ' + name);
  } else {
    console.log('FAIL case ' + n + ' (' + name + '): expected ' + JSON.stringify(expected)
      + ', got ' + JSON.stringify(got) + (detail ? ' -- ' + detail : ''));
    failures += 1;
  }
}

// ---- D1a: usedTokens helper ----
// Import the helper if exported; otherwise inline a copy to test the formula.
// The helper lives in scripts/dashboard.js as an exported function after the fix.
let usedTokens;
try {
  ({ usedTokens } = require('../scripts/dashboard.js'));
} catch (_) {
  // file does not export usedTokens yet (pre-fix): simulate the old formula
  usedTokens = null;
}

if (usedTokens) {
  // Post-fix path: helper exists and must include output_tokens.
  const u1 = usedTokens({
    input_tokens: 100,
    cache_read_input_tokens: 200,
    cache_creation_input_tokens: 300,
    output_tokens: 50,
  });
  check(
    'D1a: usedTokens includes output_tokens',
    u1,
    650,
    'expected 100+200+300+50=650'
  );

  const u2 = usedTokens({
    input_tokens: 0,
    output_tokens: 77,
  });
  check(
    'D1a: usedTokens works with only output_tokens nonzero',
    u2,
    77,
    'expected 77'
  );

  const u3 = usedTokens({
    input_tokens: 10,
  });
  check(
    'D1a: usedTokens defaults missing fields to 0',
    u3,
    10,
    'expected 10'
  );
} else {
  // Pre-fix path: usedTokens not exported => these tests FAIL to record the bug.
  console.log('FAIL case ' + (++n) + ' (D1a: usedTokens not exported - pre-fix)');
  failures += 1;
  n += 2; // account for skipped cases 2 and 3
}

// ---- D1b: humanizeModel helper ----
let humanizeModel;
try {
  ({ humanizeModel } = require('../scripts/dashboard.js'));
} catch (_) {
  humanizeModel = null;
}

if (humanizeModel) {
  const h1 = humanizeModel('claude-opus-4-8[1m]');
  check(
    'D1b: humanizeModel contains Opus 4.8',
    h1.includes('Opus 4.8') || h1.includes('Opus 4'),
    true,
    'got: ' + h1
  );
  check(
    'D1b: humanizeModel contains 1M for opus-4-8[1m]',
    h1.includes('1M'),
    true,
    'got: ' + h1
  );

  const h2 = humanizeModel('claude-sonnet-4-5');
  check(
    'D1b: humanizeModel contains 200K for non-1M model',
    h2.includes('200K'),
    true,
    'got: ' + h2
  );

  const h3 = humanizeModel(null);
  check(
    'D1b: humanizeModel handles null gracefully',
    typeof h3 === 'string',
    true,
    'got: ' + h3
  );
} else {
  console.log('FAIL case ' + (++n) + ' (D1b: humanizeModel not exported - pre-fix)');
  failures += 1;
  n += 3; // account for skipped cases
}

// ---- D4: layoutTree overlap detection ----
// Build a realistic org: 1 CEO, 4 leads, 4 tier-2 children each (16 workers).
// Pre-fix code overlaps them; post-fix code must not.
let layoutTree;
try {
  ({ layoutTree } = require('../scripts/dashboard.js'));
} catch (_) {
  layoutTree = null;
}

if (layoutTree) {
  // Build org structure
  const nodes = [];
  const edges = [];
  nodes.push({ id: 'ceo', tier: 0, label: 'CEO', status: 'running' });
  for (let d = 0; d < 4; d++) {
    const leadId = 'lead' + d;
    nodes.push({ id: leadId, tier: 1, label: 'Lead ' + d, status: 'active' });
    edges.push({ from: 'ceo', to: leadId });
    for (let w = 0; w < 4; w++) {
      const wId = 'worker' + d + '_' + w;
      nodes.push({ id: wId, tier: 2, label: 'Worker ' + d + '.' + w, status: 'running' });
      edges.push({ from: leadId, to: wId });
    }
  }

  const org = { nodes, edges };
  const { placed } = layoutTree(org);

  const nodeW = 140;
  const nodeH = 36;

  // Check no node has negative x
  let negX = false;
  for (const id of Object.keys(placed)) {
    if (placed[id].x < 0) { negX = true; break; }
  }
  check('D4: no node has negative x', negX, false);

  // Check pairwise non-overlap (axis-aligned bounding box intersection)
  const ids = Object.keys(placed);
  let overlapCount = 0;
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      const a = placed[ids[i]];
      const b = placed[ids[j]];
      // Two rects overlap if their x and y ranges both intersect.
      const xOverlap = a.x < b.x + nodeW && a.x + nodeW > b.x;
      const yOverlap = a.y < b.y + nodeH && a.y + nodeH > b.y;
      if (xOverlap && yOverlap) overlapCount += 1;
    }
  }
  check(
    'D4: zero overlapping node pairs',
    overlapCount,
    0,
    overlapCount + ' overlapping pairs found'
  );

  // All 21 nodes must be placed
  check(
    'D4: all 21 nodes placed',
    ids.length,
    21
  );
} else {
  console.log('FAIL case ' + (++n) + ' (D4: layoutTree not exported - pre-fix)');
  failures += 1;
  n += 2; // account for skipped cases
}

if (failures) {
  console.log('DASHBOARD D1/D4 TESTS FAILED: ' + failures + ' of ' + n + ' cases');
  process.exit(1);
}
console.log('ALL DASHBOARD D1/D4 TESTS PASSED (' + n + ' checks)');
