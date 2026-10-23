/**
 * 轻量 Owner / Scope 生命周期树。
 *
 * 组件内部的 signal/effect 已经由 ReactiveElement 托管；但 composable 或
 * 组件外创建的 effect 仍需要一个显式归属。`createScope()` 提供这层归属：
 * - 作用域内创建的 effect / memo / resource 会自动注册清理；
 * - `dispose()` 统一解除订阅，避免组件卸载后继续响应。
 */
export interface Owner {
  parent: Owner | null;
  disposers: Set<() => void>;
  disposed: boolean;
}

export interface Scope<T> {
  value: T;
  dispose: () => void;
}

const ownerStack: Owner[] = [];

export const getOwner = (): Owner | undefined => {
  return ownerStack[ownerStack.length - 1];
};

export const runWithOwner = <T>(owner: Owner | undefined, run: () => T): T => {
  if (!owner) {
    return run();
  }

  ownerStack.push(owner);

  try {
    return run();
  } finally {
    ownerStack.pop();
  }
};

/**
 * 把清理函数挂到当前 owner；没有 owner 时原样返回，由调用方自行管理。
 */
export const onOwnerCleanup = (cleanup: () => void): (() => void) => {
  const owner = getOwner();

  if (!owner) {
    return cleanup;
  }

  if (owner.disposed) {
    cleanup();
    return cleanup;
  }

  owner.disposers.add(cleanup);

  return () => {
    owner.disposers.delete(cleanup);
  };
};

export const createScope = <T>(run: (owner: Owner) => T): Scope<T> => {
  const owner: Owner = {
    parent: getOwner() ?? null,
    disposers: new Set(),
    disposed: false,
  };

  const value = runWithOwner(owner, () => run(owner));

  const dispose = (): void => {
    if (owner.disposed) {
      return;
    }

    owner.disposed = true;

    for (const cleanup of [...owner.disposers]) {
      try {
        cleanup();
      } catch {
        // 单个清理失败不应阻断其余清理。
      }
    }

    owner.disposers.clear();
  };

  return { value, dispose };
};
