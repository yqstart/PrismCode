// ==================== 只读虚拟标签路径 ====================
// 这些标签的内容由进程内数据生成（jdt 反编译类、Spring 端点清单等），
// 不进磁盘、不可编辑、不参与 Git 装饰与保存。判定集中在这里，
// 避免各处各写一份前缀列表（新增虚拟 scheme 只改这一处）。

export const READ_ONLY_VIRTUAL_SCHEMES = ["jdt:", "spring:"] as const;

export function isReadOnlyVirtualPath(path: string): boolean {
  return READ_ONLY_VIRTUAL_SCHEMES.some((scheme) => path.startsWith(scheme));
}
