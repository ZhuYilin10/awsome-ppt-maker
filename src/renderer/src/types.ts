import type { MaterialPurpose } from '../../shared/project';
export type { Material, MaterialPurpose } from '../../shared/project';

export const purposeLabels: Record<MaterialPurpose, { label: string; description: string }> = {
  primary: { label: '待美化主稿', description: '这是要被 Agent 设计和修改的 PPT' },
  content: { label: '内容补充', description: '为主稿提供文字、数据或背景材料' },
  reference: { label: '风格参考', description: '只参考视觉语言，不直接复制内容' },
  asset: { label: '图片 / 品牌素材', description: 'Logo、照片、图标或其他要使用的素材' },
  auto: { label: '让 Agent 判断', description: '由 Agent 根据文件内容推荐用途' },
};

export function formatFileSize(size: number) {
  if (!size) return '文件已选中';
  if (size < 1024 * 1024) return `${Math.max(1, Math.round(size / 1024))} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}
