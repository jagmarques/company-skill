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

// Install skill
copyFile(path.join(srcDir, 'skill', 'SKILL.md'), path.join(skillDir, 'SKILL.md'));

// Install commands
for (const cmd of ['run', 'status', 'resume']) {
  const src = path.join(srcDir, 'commands', `${cmd}.md`);
  if (fs.existsSync(src)) copyFile(src, path.join(commandsDir, `${cmd}.md`));
}

// Install agents
for (const agent of ['lead', 'worker', 'reviewer', 'critic', 'digest']) {
  const src = path.join(srcDir, 'agents', `company-${agent}.md`);
  if (fs.existsSync(src)) copyFile(src, path.join(agentsDir, `company-${agent}.md`));
}

// Install stop hook
const hookSrc = path.join(srcDir, 'hooks', 'stop-guard.js');
if (fs.existsSync(hookSrc)) {
  copyFile(hookSrc, path.join(hooksDir, 'company-stop-guard.js'));

  // Add to settings.json Stop hooks
  const settingsPath = path.join(home, '.claude', 'settings.json');
  try {
    const settings = fs.existsSync(settingsPath)
      ? JSON.parse(fs.readFileSync(settingsPath, 'utf8'))
      : {};

    if (!settings.hooks) settings.hooks = {};
    if (!settings.hooks.Stop) settings.hooks.Stop = [];

    const hookCmd = `node "${path.join(hooksDir, 'company-stop-guard.js')}"`;
    const exists = settings.hooks.Stop.some(h =>
      h.hooks && h.hooks.some(hh => hh.command && hh.command.includes('company-stop-guard'))
    );

    if (!exists) {
      settings.hooks.Stop.push({
        hooks: [{
          type: 'command',
          command: hookCmd,
          timeout: 5
        }]
      });
      fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
      console.log('Stop hook installed: company will not stop until goal is achieved.');
    }
  } catch (e) {
    console.log('Could not install stop hook (optional). Add manually to settings.json.');
  }
}

// Create COMPANY.md template in cwd if missing
const companyMd = path.join(process.cwd(), 'COMPANY.md');
const template = path.join(srcDir, 'COMPANY.md.template');
if (!fs.existsSync(companyMd) && fs.existsSync(template)) {
  fs.copyFileSync(template, companyMd);
  console.log('Created COMPANY.md template. Edit it with your team.');
}

// Add .company/ to .gitignore
const gitignore = path.join(process.cwd(), '.gitignore');
try {
  const content = fs.existsSync(gitignore) ? fs.readFileSync(gitignore, 'utf8') : '';
  if (!content.includes('.company/')) {
    fs.appendFileSync(gitignore, '\n.company/\n');
  }
} catch (e) {}

console.log('company-skill installed globally.');
console.log('Commands: /company, /company:run, /company:status, /company:resume');
console.log('To cancel a running company: touch .company/CANCEL');
