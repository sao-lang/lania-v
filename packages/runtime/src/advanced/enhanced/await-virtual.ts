/**
 * Promise 增强组件。
 *
 * 返回一个稳定的宿主节点，并在内部自行更新内容，
 * 因此不需要编译器为它生成额外的边界协议。
 *
 * 窗口化列表 `Virtual` 已拆分到 `./virtual`。
 */
import { defineEnhancedComponent } from './utils/factory';
import { appendRenderable, asRenderable } from './utils/renderable';
import type { AwaitProps, EnhancedRenderable } from './types';

const resolveRenderable = (
  value: unknown,
  ...args: unknown[]
): EnhancedRenderable =>
  typeof value === 'function'
    ? (value as (...values: unknown[]) => EnhancedRenderable)(...args)
    : (asRenderable(value) as EnhancedRenderable);

const isPromiseLike = (value: unknown): value is PromiseLike<unknown> =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as { then?: unknown }).then === 'function';

export const Await = defineEnhancedComponent(
  'Await',
  (props: AwaitProps): EnhancedRenderable => {
    const host = document.createElement('span');
    host.style.display = 'contents';

    const render = (value: unknown): void => {
      host.replaceChildren();
      appendRenderable(host, asRenderable(value));
    };

    const renderResolved = (value: unknown): void => {
      const content =
        typeof props.children === 'function'
          ? (props.children as (value: unknown) => unknown)(value)
          : (props.children ?? value);
      render(content);
    };

    let settled = false;
    let fallbackTimer: ReturnType<typeof setTimeout> | undefined;
    const fallback = (): EnhancedRenderable =>
      resolveRenderable(props.fallback);

    if (props.fallback) {
      if (props.delay && props.delay > 0) {
        fallbackTimer = setTimeout(() => {
          if (!settled) {
            render(fallback());
          }
        }, props.delay);
      } else {
        render(fallback());
      }
    }

    const input =
      typeof props.value === 'function'
        ? (props.value as () => unknown)()
        : props.value;

    if (!isPromiseLike(input)) {
      settled = true;
      if (fallbackTimer !== undefined) {
        clearTimeout(fallbackTimer);
      }
      renderResolved(input);
      return host;
    }

    Promise.resolve(input).then(
      (value) => {
        settled = true;
        if (fallbackTimer !== undefined) {
          clearTimeout(fallbackTimer);
        }
        props.onResolve?.(value);
        renderResolved(value);
      },
      (error: unknown) => {
        settled = true;
        if (fallbackTimer !== undefined) {
          clearTimeout(fallbackTimer);
        }
        props.onReject?.(error);
        render(
          props.error ? resolveRenderable(props.error, error) : String(error)
        );
      }
    );

    return host;
  }
);
