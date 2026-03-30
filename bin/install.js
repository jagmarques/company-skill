#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const os = require('os');

const home = os.homedir();
const skillDir = path.join(home, '.claude', 'skills', 'company');
const commandsDir = path.join(home, '.claude', 'commands', 'company');
const agentsDir = path.join(home, '.claude', 'agents');
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
