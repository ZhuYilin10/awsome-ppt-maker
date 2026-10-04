import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { runOfficeCli } from './officecli';
import type { PrototypePageSpec, PrototypePreview } from '../shared/analysis';

type Command = { command: 'add'; parent: string; type: string; props: Record<string, string> };

function commandsForPage(page: PrototypePageSpec, index: number): Command[] {
  const commands: Command[] = [{ command: 'add', parent: '/', type: 'slide', props: { layout: 'blank', background: page.prototype.background, name: `prototype-${page.sourcePageNumber}` } }];
  const slide = `/slide[${index}]`;
  for (const [blockIndex, block] of page.prototype.blocks.entries()) {
    commands.push({ command: 'add', parent: slide, type: block.geometry ? 'shape' : 'textbox', props: {
      name: `element-${blockIndex + 1}`, text: block.text,
      x: `${block.x}cm`, y: `${block.y}cm`, width: `${block.width}cm`, height: `${block.height}cm`,
      font: block.font, size: `${block.fontSize}pt`, textFill: block.color,
      fill: block.fill, line: block.line, bold: String(block.bold), align: block.align, valign: block.valign,
      margin: '0cm', autoFit: 'none', ...(block.geometry ? { geometry: block.geometry } : {}),
    } });
  }
  commands.push({ command: 'add', parent: slide, type: 'notes', props: { text: `原稿第 ${page.sourcePageNumber} 页\n${page.purpose}\n${page.visualDirection}` } });
  return commands;
}

export async function generatePrototype(root: string, projectId: string, draftRunId: string, pages: PrototypePageSpec[], signal?: AbortSignal, sourceHashes: Record<string, string> = {}): Promise<PrototypePreview> {
  const prototypeId = `${draftRunId}-prototype`;
  const prototypeRoot = join(root, 'design', 'runs', draftRunId);
  const previewRoot = join(prototypeRoot, 'previews');
  await mkdir(previewRoot, { recursive: true });
  const outputPath = join(prototypeRoot, 'prototype.pptx');
  signal?.throwIfAborted();
  await runOfficeCli(['create', outputPath], { signal });
  await runOfficeCli(['set', outputPath, '/', '--prop', 'slideSize=widescreen'], { signal });
  const commands = pages.flatMap((page, index) => commandsForPage(page, index + 1));
  const batch = JSON.parse(await runOfficeCli(['batch', outputPath, '--commands', JSON.stringify(commands), '--json'], { signal, maxBuffer: 8 * 1024 * 1024 }));
  if (!batch.success || batch.data?.summary?.failed || batch.data?.summary?.atomicRolledBack) throw new Error('原型 PPTX 生成失败，未应用完整规格。');
  const outputs: PrototypePreview['pages'] = [];
  for (let index = 0; index < pages.length; index += 1) {
    signal?.throwIfAborted();
    const previewPath = join(previewRoot, `page-${pages[index].sourcePageNumber}.png`);
    try {
      await runOfficeCli(['view', outputPath, 'screenshot', '--page', String(index + 1), '--screenshot-width', '1400', '--screenshot-height', '800', '--out', previewPath], { signal });
      outputs.push({ sourcePageNumber: pages[index].sourcePageNumber, previewPath, status: 'generated' });
    } catch (cause) {
      if (signal?.aborted) throw cause;
      outputs.push({ sourcePageNumber: pages[index].sourcePageNumber, previewPath, status: 'render-failed' });
    }
  }
  signal?.throwIfAborted();
  return { prototypeId, draftRunId, sourceProjectId: projectId, outputPath, sourceHashes, pages: outputs, createdAt: new Date().toISOString() };
}
