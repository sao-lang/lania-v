/**
 * 开发期更新高亮。
 *
 * 运行时在 dev 下会发出 `slot-write` 事件，并携带真正被写入的 DOM 节点。
 * 这里订阅该事件，用 outline 闪一下目标节点，让“细粒度更新”可以被直接看到。
 *
 * 用法：
 * ```ts
 * import { installDevtoolsOverlay } from '@lania-v/runtime/advanced';
 * const dispose = installDevtoolsOverlay();
 * ```
 */
import { registerRuntimeDebugHooks, type DevtoolsEvent } from './debug';

export interface DevtoolsOverlayOptions {
  durationMs?: number;
  color?: string;
}

const HIGHLIGHT_ATTRIBUTE = 'data-lania-update';
let styleInjected = false;

const ensureHighlightStyle = (color: string): void => {
  if (styleInjected || typeof document === 'undefined') {
    return;
  }

  const style = document.createElement('style');
  style.setAttribute('data-lania-devtools', '');
  style.textContent = `[${HIGHLIGHT_ATTRIBUTE}] { outline: 2px solid ${color} !important; outline-offset: 2px !important; transition: outline-color 120ms ease; }`;
  document.head.appendChild(style);
  styleInjected = true;
};

const resolveHighlightTarget = (node: unknown): HTMLElement | null => {
  if (!(node instanceof Node)) {
    return null;
  }

  if (node instanceof HTMLElement) {
    return node;
  }

  return node.parentElement;
};

export const installDevtoolsOverlay = (
  options: DevtoolsOverlayOptions = {}
): (() => void) => {
  if (typeof document === 'undefined' || typeof Node === 'undefined') {
    return () => undefined;
  }

  const durationMs = options.durationMs ?? 300;
  const color = options.color ?? '#22d3ee';
  ensureHighlightStyle(color);

  const timers = new Map<HTMLElement, ReturnType<typeof setTimeout>>();

  const highlight = (node: unknown): void => {
    const target = resolveHighlightTarget(node);

    if (!target) {
      return;
    }

    target.setAttribute(HIGHLIGHT_ATTRIBUTE, '');
    const existing = timers.get(target);

    if (existing) {
      clearTimeout(existing);
    }

    timers.set(
      target,
      setTimeout(() => {
        target.removeAttribute(HIGHLIGHT_ATTRIBUTE);
        timers.delete(target);
      }, durationMs)
    );
  };

  const disposeHooks = registerRuntimeDebugHooks({
    onDevtoolsEvent(event: DevtoolsEvent) {
      if (event.type !== 'slot-write') {
        return;
      }

      const payload = event.payload as { node?: unknown } | undefined;
      highlight(payload?.node);
    },
  });

  return () => {
    disposeHooks();

    timers.forEach((timer) => {
      clearTimeout(timer);
    });
    timers.clear();
  };
};
