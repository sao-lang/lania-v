/**
 * 定义 TransitionGroup 的 host 模式选择规则。
 *
 * 有显式 `transitionTag` 时走 `dom-host`，否则采用纯快照模式。
 */
export type TransitionGroupHostMode = 'snapshot' | 'dom-host';

// `transitionTag` 是否有效决定运行时是托管真实容器还是只返回快照数组。
export const resolveTransitionGroupHostMode = (
  transitionTag?: string | null
): TransitionGroupHostMode => {
  return typeof transitionTag === 'string' && transitionTag.trim().length > 0
    ? 'dom-host'
    : 'snapshot';
};

// stateKey 额外拼上 hostMode，避免同 key 在不同模式下互相污染状态。
export const createTransitionGroupStateKey = (
  keySource: PropertyKey | string | null | undefined,
  hostMode: TransitionGroupHostMode
): string => {
  return `${String(keySource ?? 'default')}:${hostMode}`;
};
