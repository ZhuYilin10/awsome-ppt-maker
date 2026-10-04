import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, realpath, stat } from 'node:fs/promises';
import { extname, isAbsolute, join, relative } from 'node:path';
import sharp from 'sharp';
import { createCanvas, DOMMatrix, ImageData, Path2D } from '@napi-rs/canvas';
import type { ProjectRecord, StoredMaterial } from '../shared/project';
import { runOfficeCli } from './officecli';

export type MaterialFacts = { materialId: string; sha256: string; kind: string; pageCount?: number; width?: number; height?: number; text?: string; stats?: unknown; warning?: string; error?: string };
const IMAGE_LIMIT = 40_000_000;
const dynamicImport = new Function('specifier', 'return import(specifier)') as (specifier: string) => Promise<typeof import('pdfjs-dist/legacy/build/pdf.mjs')>;

export async function authorizedMaterial(record: ProjectRecord, id: string) {
  const material = record.materials.find((item) => item.id === id);
  if (!material) throw new Error('材料不存在。');
  const root = await realpath(join(record.projectPath, 'materials'));
  const path = await realpath(material.localPath);
  const subpath = relative(root, path);
  if (!subpath || subpath.startsWith('..') || isAbsolute(subpath)) throw new Error('材料路径不在当前项目目录内。');
  const info = await stat(path);
  if (!info.isFile() || info.size === 0 || info.size > 150 * 1024 * 1024) throw new Error('材料为空或超过 150 MB 分析限制。');
  return { ...material, localPath: path };
}

export async function hashFile(path: string, signal?: AbortSignal) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path, { signal })) hash.update(chunk);
  return hash.digest('hex');
}

class CanvasFactory {
  create(width: number, height: number) { const canvas = createCanvas(width, height); return { canvas, context: canvas.getContext('2d') }; }
  reset(target: { canvas: ReturnType<typeof createCanvas> }, width: number, height: number) { target.canvas.width = width; target.canvas.height = height; }
  destroy(target: { canvas: ReturnType<typeof createCanvas> }) { target.canvas.width = 0; target.canvas.height = 0; }
}

async function openPdf(path: string, signal?: AbortSignal) {
  signal?.throwIfAborted();
  Object.assign(globalThis, { DOMMatrix, ImageData, Path2D });
  const pdf = await dynamicImport('pdfjs-dist/legacy/build/pdf.mjs');
  const task = pdf.getDocument({ data: new Uint8Array(await readFile(path)), useSystemFonts: true, CanvasFactory: CanvasFactory as any });
  const abort = () => { void task.destroy().catch(() => undefined); };
  signal?.addEventListener('abort', abort, { once: true });
  try {
    signal?.throwIfAborted();
    return { document: await task.promise, destroy: async () => { signal?.removeEventListener('abort', abort); await task.destroy(); } };
  } catch (cause) { signal?.removeEventListener('abort', abort); await task.destroy().catch(() => undefined); throw cause; }
}

export async function readPdf(path: string, signal?: AbortSignal) {
  const { document, destroy } = await openPdf(path, signal);
  try {
    const pages: { pageNumber: number; width: number; height: number; text: string }[] = [];
    let remaining = 80_000;
    for (let number = 1; number <= Math.min(document.numPages, 200) && remaining > 0; number++) {
      signal?.throwIfAborted();
      const page = await document.getPage(number);
      const viewport = page.getViewport({ scale: 1 });
      const content = await page.getTextContent();
      const text = content.items.map((item) => 'str' in item ? item.str + (item.hasEOL ? '\n' : ' ') : '').join('').slice(0, remaining);
      remaining -= text.length;
      pages.push({ pageNumber: number, width: viewport.width, height: viewport.height, text });
      page.cleanup();
    }
    return { pageCount: document.numPages, pages, truncated: pages.length < document.numPages || remaining <= 0, warning: pages.some((page) => !page.text.trim()) ? '部分页面没有可提取文字；需要页面视觉读取，未执行中文 OCR。' : undefined };
  } finally { await destroy(); }
}

export async function renderPdf(path: string, pageNumber: number, output: string, signal?: AbortSignal) {
  const { document, destroy } = await openPdf(path, signal);
  try {
    if (!Number.isInteger(pageNumber) || pageNumber < 1 || pageNumber > document.numPages) throw new Error('PDF 页码越界。');
    signal?.throwIfAborted();
    const page = await document.getPage(pageNumber);
    const size = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale: Math.min(2, 1600 / Math.max(size.width, size.height)) });
    const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
    const render = page.render({ canvasContext: canvas.getContext('2d') as any, canvas: canvas as any, viewport });
    const abort = () => render.cancel();
    signal?.addEventListener('abort', abort, { once: true });
    try { await render.promise; } finally { signal?.removeEventListener('abort', abort); }
    await sharp(await canvas.encode('png')).jpeg({ quality: 85 }).toFile(output);
    return output;
  } finally { await destroy(); }
}

export async function inspectImage(path: string, output: string, regionNumber = 1) {
  const image = sharp(path, { limitInputPixels: IMAGE_LIMIT });
  const metadata = await image.metadata();
  if (!metadata.width || !metadata.height) throw new Error('无法读取图片尺寸。');
  const tall = metadata.height > metadata.width * 2;
  const segmentHeight = tall ? Math.min(1800, metadata.height) : metadata.height;
  const step = Math.max(1, segmentHeight - 160);
  const regionCount = tall ? Math.ceil(Math.max(0, metadata.height - segmentHeight) / step) + 1 : 1;
  if (!Number.isInteger(regionNumber) || regionNumber < 1 || regionNumber > regionCount) throw new Error('图片分片编号越界。');
  const top = Math.min((regionNumber - 1) * step, metadata.height - segmentHeight);
  await image.extract({ left: 0, top, width: metadata.width, height: segmentHeight }).resize({ width: 1400, height: 1800, fit: 'inside', withoutEnlargement: true }).flatten({ background: '#ffffff' }).jpeg({ quality: 85 }).toFile(output);
  return { width: metadata.width, height: metadata.height, format: metadata.format, regionNumber, regionCount, top, regionHeight: segmentHeight, warning: '未执行中文 OCR；图片文字由模型视觉能力识别。' };
}

export async function scanMaterial(material: StoredMaterial, signal?: AbortSignal): Promise<MaterialFacts> {
  const kind = extname(material.localPath).toLowerCase().slice(1);
  const facts: MaterialFacts = { materialId: material.id, sha256: await hashFile(material.localPath, signal), kind };
  try {
    signal?.throwIfAborted();
    if (['pptx', 'docx', 'xlsx'].includes(kind)) {
      facts.stats = JSON.parse(await runOfficeCli(['view', material.localPath, 'stats', '--json'], { signal }));
      const envelope = facts.stats as { data?: { slides?: number } };
      if (kind === 'pptx') {
        facts.pageCount = envelope.data?.slides;
        if (!Number.isInteger(facts.pageCount) || facts.pageCount! < 1) throw new Error('OfficeCLI 未返回有效的主稿页数。');
      }
      facts.text = (await runOfficeCli(['view', material.localPath, 'outline', '--json'], { signal })).slice(0, 80_000);
      facts.warning = 'OfficeCLI 的 HTML 预览不等同 PowerPoint 原生渲染；普通图片统计不涵盖母版资产。';
    } else if (kind === 'pdf') {
      const pdf = await readPdf(material.localPath, signal);
      facts.pageCount = pdf.pageCount;
      facts.text = JSON.stringify(pdf.pages);
      facts.warning = pdf.warning;
    } else {
      const meta = await sharp(material.localPath, { limitInputPixels: IMAGE_LIMIT }).metadata();
      facts.width = meta.width; facts.height = meta.height; facts.pageCount = 1; facts.warning = '单张图片记为第 1 页；长图请在 location 中引用分片编号和像素区间。中文 OCR 未启用。';
    }
  } catch (cause) {
    if (signal?.aborted) throw cause;
    facts.error = cause instanceof Error ? cause.message : '材料读取失败。';
  }
  return facts;
}

export async function ensurePreviewDirectory(root: string) { await mkdir(join(root, 'previews'), { recursive: true }); }
