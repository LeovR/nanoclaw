import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';

describe('bring skill package', () => {
  const skillDir = path.resolve(__dirname, '..');

  it('has a valid manifest with required fields', () => {
    const manifestPath = path.join(skillDir, 'manifest.yaml');
    expect(fs.existsSync(manifestPath)).toBe(true);

    const content = fs.readFileSync(manifestPath, 'utf-8');
    expect(content).toContain('skill: bring');
    expect(content).toContain('version: 1.0.0');
    expect(content).toContain('BRING_EMAIL');
    expect(content).toContain('BRING_PASSWORD');
  });

  it('has all files declared in adds', () => {
    const bringCliTs = path.join(skillDir, 'add', 'container', 'bring-cli', 'bring-cli.ts');
    const packageJson = path.join(skillDir, 'add', 'container', 'bring-cli', 'package.json');
    const tsconfigJson = path.join(skillDir, 'add', 'container', 'bring-cli', 'tsconfig.json');
    const agentSkillMd = path.join(skillDir, 'add', 'container', 'skills', 'bring', 'SKILL.md');

    expect(fs.existsSync(bringCliTs)).toBe(true);
    expect(fs.existsSync(packageJson)).toBe(true);
    expect(fs.existsSync(tsconfigJson)).toBe(true);
    expect(fs.existsSync(agentSkillMd)).toBe(true);
  });

  it('has all files declared in modifies', () => {
    const dockerfile = path.join(skillDir, 'modify', 'container', 'Dockerfile');
    const containerRunner = path.join(skillDir, 'modify', 'src', 'container-runner.ts');
    const containerRunnerTest = path.join(skillDir, 'modify', 'src', 'container-runner.test.ts');

    expect(fs.existsSync(dockerfile)).toBe(true);
    expect(fs.existsSync(containerRunner)).toBe(true);
    expect(fs.existsSync(containerRunnerTest)).toBe(true);
  });

  it('has intent files for all modified files', () => {
    expect(fs.existsSync(path.join(skillDir, 'modify', 'container', 'Dockerfile.intent.md'))).toBe(true);
    expect(fs.existsSync(path.join(skillDir, 'modify', 'src', 'container-runner.ts.intent.md'))).toBe(true);
    expect(fs.existsSync(path.join(skillDir, 'modify', 'src', 'container-runner.test.ts.intent.md'))).toBe(true);
  });

  it('bring-cli.ts contains expected commands', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'add', 'container', 'bring-cli', 'bring-cli.ts'),
      'utf-8',
    );

    expect(content).toContain("'lists'");
    expect(content).toContain("'items'");
    expect(content).toContain("'add'");
    expect(content).toContain("'remove'");
    expect(content).toContain("'complete'");
    expect(content).toContain("'help'");
  });

  it('modified Dockerfile includes bring-cli installation', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'modify', 'container', 'Dockerfile'),
      'utf-8',
    );

    expect(content).toContain('bring-cli');
    expect(content).toContain('COPY bring-cli/');
    expect(content).toContain('npm install -g');
  });

  it('modified container-runner.ts passes BRING env vars', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'modify', 'src', 'container-runner.ts'),
      'utf-8',
    );

    expect(content).toContain('BRING_EMAIL');
    expect(content).toContain('BRING_PASSWORD');
    expect(content).toContain('readEnvFile');
  });

  it('modified container-runner.test.ts has BRING env var test cases', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'modify', 'src', 'container-runner.test.ts'),
      'utf-8',
    );

    expect(content).toContain('BRING env vars');
    expect(content).toContain('passes BRING credentials as container env vars when set');
    expect(content).toContain('omits BRING env vars when not configured');
  });

  it('agent-facing SKILL.md documents all commands', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'add', 'container', 'skills', 'bring', 'SKILL.md'),
      'utf-8',
    );

    expect(content).toContain('bring-cli lists');
    expect(content).toContain('bring-cli items');
    expect(content).toContain('bring-cli add');
    expect(content).toContain('bring-cli remove');
    expect(content).toContain('bring-cli complete');
    expect(content).toContain('allowed-tools');
  });
});
