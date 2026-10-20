/**
 * 列表选中态选择器。
 *
 * 常见写法 `selectedId() === item.id` 会让每个 item 的 updater 都订阅 selectedId，
 * 一次选中变化就会触发整列表重算。`createSelector` 把每个 key 的布尔结果
 * 独立成一个小 signal，只在“该 key 的选中态真的变化”时更新。
 *
 * 用法：
 * ```ts
 * const isSelected = createSelector(selectedId);
 * // 模板里：isSelected(item.id)
 * onCleanup(isSelected.dispose);
 * ```
 */
import {
  createEffect,
  createSignal,
  type Signal,
  type SignalSource,
} from './signal';

export interface Selector<T, K = T> {
  (key: K): boolean;
  dispose(): void;
}

export const createSelector = <T, K = T>(
  source: SignalSource<T>,
  equals: (key: K, value: T) => boolean = (key, value) => Object.is(key, value)
): Selector<T, K> => {
  const signals = new Map<K, Signal<boolean>>();
  const stop = createEffect(() => {
    const current = source.value;

    for (const [key, signal] of signals) {
      signal.set(equals(key, current));
    }
  });

  const selector = ((key: K): boolean => {
    let signal = signals.get(key);

    if (!signal) {
      signal = createSignal(equals(key, source.peek()));
      signals.set(key, signal);
    }

    return signal.value;
  }) as Selector<T, K>;

  selector.dispose = () => {
    stop();
    signals.clear();
  };

  return selector;
};
