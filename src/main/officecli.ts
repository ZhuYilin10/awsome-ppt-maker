import { execFile } from 'node:child_process';
import { access } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { MaterialAnalysis } from '../shared/project';

const exec = promisify(execFile);
let resolvedBinary: string | undefined;

async function binary() {
  if (resolvedBinary) return resolvedBinary;
  // Desktop apps launched from Finder do not inherit the interactive shell PATH.
  const candidates = [process.env.OFFICECLI_PATH, join(homedir(), '.local/bin/officecli'), '/opt/homebrew/bin/officecli', '/usr/local/bin/officecli', 'officecli'];
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      if (candidate !== 'officecli') await access(candidate);
      await exec(candidate, ['--version'], { timeout: 10_000 });
      resolvedBinary = candidate;
      return candidate;
    } catch { /* Try the next known location. */ }
  }
  throw new Error('未找到 OfficeCLI。请安装 OfficeCLI，或设置 OFFICECLI_PATH 后重启应用。');
}

export async function officeStatus() {
  try {
    const { stdout } = await exec(await binary(), ['--version'], { timeout: 10_000 });
    return { available: true, version: stdout.trim() };
  } catch { return { available: false }; }
}

export async function analyzeOfficeFile(localPath: string): Promise<MaterialAnalysis> {
  if (!/\.(pptx|docx|xlsx)$/i.test(localPath)) {
    return { status: 'skipped', message: '文件已保存；PDF 和图片的内容识别将在 Agent 阶段接入。' };
  }
  try {
    const { stdout } = await exec(await binary(), ['view', localPath, 'stats', '--json'], {
      timeout: 120_000,
      maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env, OFFICECLI_SKIP_UPDATE: '1' },
    });
    // Retain the actual tool result; do not fabricate slide counts or semantic analysis.
    const result: unknown = JSON.parse(stdout);
    return { status: 'analyzed', summary: JSON.stringify(result, null, 2) };
  } catch (cause) {
    return { status: 'error', message: cause instanceof Error ? cause.message : 'OfficeCLI 分析失败，请重试。' };
  }
}
