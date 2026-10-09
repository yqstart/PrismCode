export const MAX_COMPARE_TABS = 6;

/**
 * 返回插入新标签后应保留的标签 id 序列。
 * 超出上限时丢弃最旧的非激活标签；新标签本身保留。
 */
export function planCompareTabEviction(
  ids: readonly string[],
  activeId: string | null,
  incomingId: string,
): string[] {
  if (ids.includes(incomingId)) return [...ids];
  const next = [...ids, incomingId];
  while (next.length > MAX_COMPARE_TABS) {
    const victim =
      next.find((id) => id !== incomingId && id !== activeId) ??
      next.find((id) => id !== incomingId);
    if (!victim) break;
    next.splice(next.indexOf(victim), 1);
  }
  return next;
}
