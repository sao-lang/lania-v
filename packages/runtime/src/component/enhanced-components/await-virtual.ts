/**
 * Promise 与窗口化列表增强组件。
 *
 * 两者都返回一个稳定的宿主节点，并在内部自行更新内容，
 * 因此不需要编译器为它们生成额外的边界协议。
 */
import { defineEnhancedComponent } from './utils/factory';
import { appendRenderable, asRenderable } from './utils/renderable';
import type { AwaitProps, EnhancedRenderable, VirtualProps } from './types';

const resolveRenderable = (
  value: unknown,
  ...args: unknown[]
): EnhancedRenderable =>
  typeof value === 'function'
    ? (value as (...values: unknown[]) => EnhancedRenderable)(...args)
    : asRenderable(value);

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
          : props.children ?? value;
      render(content);
    };

    let settled = false;
    let fallbackTimer: ReturnType<typeof setTimeout> | undefined;
    const fallback = (): EnhancedRenderable => resolveRenderable(props.fallback);

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

export const Virtual = defineEnhancedComponent(
  'Virtual',
  (props: VirtualProps): EnhancedRenderable => {
    const host = document.createElement(props.tag ?? 'div');
    host.style.overflow = 'auto';
    host.style.position = 'relative';
    host.style.height = `${props.height}px`;

    const spacer = document.createElement('div');
    spacer.style.position = 'relative';
    spacer.style.height = `${props.items.length * props.itemHeight}px`;
    host.appendChild(spacer);

    const renderChildren = (
      item: unknown,
      index: number
    ): EnhancedRenderable => {
      if (typeof props.children === 'function') {
        return (
          props.children as (
            item: unknown,
            index: number
          ) => EnhancedRenderable
        )(item, index);
      }
      return asRenderable(props.children);
    };

    const renderRange = (): void => {
      const overscan = Math.max(0, props.overscan ?? 2);
      const start = Math.max(
        0,
        Math.floor(host.scrollTop / props.itemHeight) - overscan
      );
      const visibleCount = Math.ceil(props.height / props.itemHeight);
      const end = Math.min(
        props.items.length,
        start + visibleCount + overscan * 2
      );

      spacer.replaceChildren();
      for (let index = start; index < end; index += 1) {
        const row = document.createElement('div');
        row.style.position = 'absolute';
        row.style.top = `${index * props.itemHeight}px`;
        row.style.left = '0';
        row.style.right = '0';
        row.style.height = `${props.itemHeight}px`;
        if (props.key) {
          row.dataset.key = String(props.key(props.items[index], index));
        }
        appendRenderable(row, renderChildren(props.items[index], index));
        spacer.appendChild(row);
      }
    };

    host.addEventListener('scroll', () => {
      props.onScroll?.(host.scrollTop);
      renderRange();
    });

    renderRange();
    return host;
  }
);
