/**
 * 保存 TransitionGroup 的共享状态仓库。
 *
 * 所有 group runtime 都通过 `stateKey` 在这里读写 previous state。
 */
import type { TransitionGroupState } from '../types';

// 用 stateKey 区分不同 group 实例及其 host 模式。
const transitionGroupStates = new Map<string, TransitionGroupState<unknown>>();

export const __resetTransitionGroupStateForTests = (): void => {
  transitionGroupStates.clear();
};

export const getTransitionGroupState = <TRenderable>(
  stateKey: string
): TransitionGroupState<TRenderable> | undefined => {
  return transitionGroupStates.get(stateKey) as TransitionGroupState<TRenderable> | undefined;
};

export const setTransitionGroupState = <TRenderable>(
  stateKey: string,
  state: TransitionGroupState<TRenderable>
): TransitionGroupState<TRenderable> => {
  transitionGroupStates.set(stateKey, state as TransitionGroupState<unknown>);
  return state;
};

// 更新函数返回 null 时保持原状态不变，便于调用方按需短路。
export const updateTransitionGroupState = <TRenderable>(
  stateKey: string,
  update: (
    current: TransitionGroupState<TRenderable>
  ) => TransitionGroupState<TRenderable> | null
): TransitionGroupState<TRenderable> | null => {
  const current = getTransitionGroupState<TRenderable>(stateKey);
  if (!current) {
    return null;
  }

  const next = update(current);
  if (!next) {
    return null;
  }

  return setTransitionGroupState(stateKey, next);
};
