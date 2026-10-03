import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProjectStore, validateProject } from '../src/main/project-store';

test('import, persist, reopen, update without duplicating projects or modifying originals', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ppt-plan-test-'));
  const original = join(root, 'source.pptx');
  await writeFile(original, 'original fixture bytes');
  let store = new ProjectStore(join(root, 'projects'), join(root, 'index.sqlite'));
  try {
    const [selected] = await store.select([original]);
    const record = await store.save({ name: '申报项目', brief: '保留 Logo', materials: [{ ...selected, purpose: 'primary', note: '完整保留文字' }] });
    assert.notEqual(record.materials[0].localPath, original);
    assert.equal(await readFile(record.materials[0].localPath, 'utf8'), 'original fixture bytes');
    store.close();
    store = new ProjectStore(join(root, 'projects'), join(root, 'index.sqlite'));
    const reopened = store.get(record.id);
    assert.equal(reopened.materials[0].note, '完整保留文字');
    const updated = await store.save({ id: record.id, name: '更新名称', brief: '首页不动', materials: reopened.materials.map((material) => ({ ...material, note: '更新后的说明' })) });
    assert.equal(updated.id, record.id);
    assert.equal(store.list().length, 1);
    assert.equal(store.get(record.id).materials[0].note, '更新后的说明');
    assert.equal(await readFile(original, 'utf8'), 'original fixture bytes');
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test('reject missing primary, invalid main file, unauthorized paths', async () => {
  assert.throws(() => validateProject({ name: '测试', brief: '', materials: [] }), /材料/);
  const root = await mkdtemp(join(tmpdir(), 'ppt-plan-test-'));
  const store = new ProjectStore(join(root, 'projects'), join(root, 'index.sqlite'));
  try {
    const bad = { id: 'invented', name: 'file.pptx', sourcePath: '/etc/passwd', size: 10, note: '', purpose: 'primary' as const };
    await assert.rejects(() => store.save({ name: '测试', brief: '', materials: [bad] }), /授权/);
    assert.equal(store.list().length, 0);
    assert.throws(() => validateProject({ name: '测试', brief: '', materials: [{ ...bad, name: 'file.pdf' }] }), /PPTX/);
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});
