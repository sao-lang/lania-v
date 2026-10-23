/**
 * 面向编译器的内部辅助。
 *
 * atom 本身就是 Signal 形态（`value` getter + `updaters`），
 * updater 可以直接把它加进 `deps`；这里额外做一次形状校验，
 * 便于在编译产物跑错对象时给出明确错误。
 */
export const getAtomDependency = (
  atom: unknown
): { readonly value: unknown; updaters: Set<() => void> } => {
  if (
    atom === null ||
    (typeof atom !== 'object' && typeof atom !== 'function') ||
    !('updaters' in (atom as object))
  ) {
    throw new TypeError(
      'getAtomDependency() expects an atom created by @lania-v/store.'
    );
  }

  return atom as { readonly value: unknown; updaters: Set<() => void> };
};
