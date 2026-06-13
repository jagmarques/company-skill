#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const os = require('os');

const home = os.homedir();
const skillDir = path.join(home, '.claude', 'skills', 'company');
const commandsDir = path.join(home, '.claude', 'commands', 'company');
const agentsDir = path.join(home, '.claude', 'agents');
const hooksDir = path.join(home, '.claude', 'hooks');
const srcDir = path.dirname(__dirname);

function copyFile(src, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
}

copyFile(path.join(srcDir, 'skill', 'SKILL.md'), path.join(skillDir, 'SKILL.md'));

// Scripts are runtime dependencies referenced from SKILL.md (codegraph.js,
// check-contracts.js, check-findings.js, restart-debate.js, dashboard.js,
// secret-scan.js). check.sh and test files stay in the repo only.
const INSTALL_SCRIPTS = [
  'codegraph.js',
  'check-contracts.js',
  'check-findings.js',
  'restart-debate.js',
  'dashboard.js',
  'secret-scan.js',
];
const scriptsDestDir = path.join(skillDir, 'scripts');
for (const script of INSTALL_SCRIPTS) {
  const srcPath = path.join(srcDir, 'scripts', script);
  if (fs.existsSync(srcPath)) copyFile(srcPath, path.join(scriptsDestDir, script));
}

for (const cmd of ['run', 'status', 'resume']) {
  const src = path.join(srcDir, 'commands', `${cmd}.md`);
  if (fs.existsSync(src)) copyFile(src, path.join(commandsDir, `${cmd}.md`));
}

for (const agent of ['lead', 'worker', 'reviewer', 'critic', 'digest']) {
  const src = path.join(srcDir, 'agents', `company-${agent}.md`);
  if (fs.existsSync(src)) copyFile(src, path.join(agentsDir, `company-${agent}.md`));
}

const hookFiles = {
  'stop-guard.js': 'company-stop-guard.js',
  'context-guard.js': 'company-context-guard.js',
  'precompact.js': 'company-precompact.js',
  'session-restore.js': 'company-session-restore.js'
};

for (const [src, dest] of Object.entries(hookFiles)) {
  const srcPath = path.join(srcDir, 'hooks', src);
  if (fs.existsSync(srcPath)) copyFile(srcPath, path.join(hooksDir, dest));
}

// Register hooks in settings.json
const settingsPath = path.join(home, '.claude', 'settings.json');
try {
  const settings = fs.existsSync(settingsPath)
    ? JSON.parse(fs.readFileSync(settingsPath, 'utf8'))
    : {};

  if (!settings.hooks) settings.hooks = {};

  if (!settings.hooks.Stop) settings.hooks.Stop = [];
  if (!settings.hooks.Stop.some(h => h.hooks?.some(hh => hh.command?.includes('company-stop-guard')))) {
    settings.hooks.Stop.push({ hooks: [{ type: 'command', command: `node "${path.join(hooksDir, 'company-stop-guard.js')}"`, timeout: 10 }] });
  }
  if (!settings.hooks.Stop.some(h => h.hooks?.some(hh => hh.command?.includes('company-context-guard')))) {
    settings.hooks.Stop.push({ hooks: [{ type: 'command', command: `node "${path.join(hooksDir, 'company-context-guard.js')}"`, timeout: 10 }] });
  }

  if (!settings.hooks.PreCompact) settings.hooks.PreCompact = [];
  if (!settings.hooks.PreCompact.some(h => h.hooks?.some(hh => hh.command?.includes('company-precompact')))) {
    settings.hooks.PreCompact.push({ hooks: [{ type: 'command', command: `node "${path.join(hooksDir, 'company-precompact.js')}"`, timeout: 10 }] });
  }

  if (!settings.hooks.SessionStart) settings.hooks.SessionStart = [];
  if (!settings.hooks.SessionStart.some(h => h.hooks?.some(hh => hh.command?.includes('company-session-restore')))) {
    settings.hooks.SessionStart.push({ matcher: 'compact', hooks: [{ type: 'command', command: `node "${path.join(hooksDir, 'company-session-restore.js')}"`, timeout: 10 }] });
  }

  // Atomic write: a crash mid-write must not corrupt the user's settings.
  const tmpPath = settingsPath + '.tmp';
  fs.writeFileSync(tmpPath, JSON.stringify(settings, null, 2));
  fs.renameSync(tmpPath, settingsPath);
  console.log('Hooks installed: Stop guard + Context guard + PreCompact + SessionStart restore');
} catch (e) {
  console.log('Could not register hooks. Add manually to settings.json.');
}

const companyMd = path.join(process.cwd(), 'COMPANY.md');
const template = path.join(srcDir, 'COMPANY.md.template');
if (!fs.existsSync(companyMd) && fs.existsSync(template)) {
  fs.copyFileSync(template, companyMd);
  console.log('Created COMPANY.md template.');
}

try {
  const gi = path.join(process.cwd(), '.gitignore');
  const content = fs.existsSync(gi) ? fs.readFileSync(gi, 'utf8') : '';
  if (!content.includes('.company/')) fs.appendFileSync(gi, '\n.company/\n');
} catch (e) {}

console.log('company-skill installed.');
console.log('Commands: /company, /company:run, /company:status, /company:resume');
console.log('Cancel: touch .company/CANCEL');
