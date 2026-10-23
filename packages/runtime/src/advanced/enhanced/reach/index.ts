/**
 * `Reach`：触底 / 进入视口哨兵。
 *
 * 无限滚动、图片懒加载、曝光埋点的共同形态都是「一个哨兵进入视野就通知一次」。
 * 这类逻辑过去散落在组件里手写 `IntersectionObserver`，还要自己处理
 * 「加载中不要重复触发」「到底了不要再触发」，很容易写错。
 *
 * `Reach` 把这些收敛成一个哨兵：
 * - `mode: 'root'`：盯滚动容器底部（默认），用于无限列表；
 * - `mode: 'viewport'`：盯哨兵自身是否进入视口，用于懒加载 / 曝光。
 */
import { defineEnhancedComponent } from '../utils/factory';
import { appendRenderable, asRenderable } from '../utils/renderable';
import type { EnhancedRenderable, ReachProps } from '../types';

/** 哨兵元素的标记，便于测试与调试定位。 */
export const REACH_SENTINEL_ATTRIBUTE = 'data-reach-sentinel';

export interface ReachController {
  readonly sentinel: HTMLElement;
  /** 建立观察；宿主挂载后才能解析滚动祖先，因此由挂载流程调用。 */
  connect(): void;
  /** 手动触发一次底部检查，供 resize / 内容变化后重新评估。 */
  check(): void;
  destroy(): void;
}

const isElementLike = (value: unknown): value is Element =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as Element).getBoundingClientRect === 'function' &&
  typeof (value as Element).addEventListener === 'function';

/** 该元素自身是否是滚动容器（有纵向/横向溢出）。 */
const isScrollableBox = (
  value: Element
): value is Element & {
  scrollHeight: number;
  scrollTop: number;
  clientHeight: number;
} => {
  const style = window.getComputedStyle(value);

  return (
    /(auto|scroll|overlay)/.test(style.overflowY) ||
    /(auto|scroll|overlay)/.test(style.overflow)
  );
};

const resolveRoot = (
  root: ReachProps['root'],
  container: HTMLElement | null
): Element | null => {
  if (root === null) {
    return null;
  }

  if (typeof root === 'string') {
    return document.querySelector(root);
  }

  // 用鸭子类型而不是 `instanceof`：打包/跨 realm 场景下构造函数可能不是同一个。
  if (isElementLike(root)) {
    return root;
  }

  // 未显式指定时，向上找第一个可滚动的祖先；都没有就退回视口。
  let current: HTMLElement | null = container?.parentElement ?? null;

  while (current) {
    const style = window.getComputedStyle(current);

    if (/(auto|scroll|overlay)/.test(style.overflowY)) {
      return current;
    }

    current = current.parentElement;
  }

  return null;
};

/** 创建哨兵并接管触发逻辑。 */
export const createReachController = (props: ReachProps): ReachController => {
  const sentinel = document.createElement('div');
  sentinel.setAttribute(REACH_SENTINEL_ATTRIBUTE, '');
  // 0 高度元素在 IntersectionObserver 里几乎永远不会产生交集，
  // 因此给 1px 的可观测尺寸，同时用负 margin 抵消对布局的影响。
  sentinel.style.height = '1px';
  sentinel.style.marginTop = '-1px';
  sentinel.style.width = '100%';
  sentinel.style.pointerEvents = 'none';

  let destroyed = false;
  let fired = false;
  let observer: IntersectionObserver | null = null;
  let resolvedRoot: Element | null = null;
  let detachScroll: (() => void) | null = null;

  const trigger = (): void => {
    if (destroyed || (props.once && fired)) {
      return;
    }

    fired = true;

    try {
      props.onReach?.();
    } catch (error) {
      // 回调抛错不应让观察器失效；异步抛出交给宿主错误边界处理。
      queueMicrotask(() => {
        throw error;
      });
    }
  };

  /**
   * `rootMargin` 的提前量（像素）。
   * `'200px'` 表示「距底部还有 200px 就算到底」，因此触发阈值要放宽。
   */
  const readMargin = (): number => {
    const raw = props.rootMargin;

    if (!raw) {
      return 0;
    }

    const matched = /^(-?\d+(?:\.\d+)?)px$/.exec(raw.trim());
    return matched ? Math.abs(Number(matched[1])) : 0;
  };

  /**
   * 滚动兜底：优先用滚动位置判定。
   *
   * 几何法（`getBoundingClientRect`）在刚挂载、图片刚插入等场景下可能读到
   * 尚未完成的布局，容易误判；滚动位置是同步且可靠的。
   */
  const checkByScroll = (): void => {
    if (destroyed) {
      return;
    }

    const margin = readMargin();
    let distance: number;

    if (resolvedRoot && isScrollableBox(resolvedRoot)) {
      // 用 scrollHeight / scrollTop / clientHeight 直接算到底部还剩多少。
      distance =
        resolvedRoot.scrollHeight -
        resolvedRoot.scrollTop -
        resolvedRoot.clientHeight;
    } else {
      // 退回视口模式时只能靠几何：内容底部相对视口底边还有多远。
      const target = resolvedRoot ?? document.documentElement;
      const rect = target.getBoundingClientRect();
      const bottom = window.scrollY + rect.bottom;
      const sentinelRect = sentinel.getBoundingClientRect();
      distance = sentinelRect.top - (window.scrollY + window.innerHeight);
      void bottom;
    }

    // 还没进入提前量范围时视为「未到底」。

    if (distance - margin > 0) {
      // 离开底部区域后重新武装，支持「加载 → 继续滚 → 再加载」。
      if (!props.once) {
        fired = false;
      }
      return;
    }

    trigger();
  };

  const connect = (): void => {
    if (destroyed) {
      return;
    }

    resolvedRoot = resolveRoot(props.root, sentinel);

    // `root` 模式的语义是「到底部」，滚动几何比交叉比例更准确，因此始终挂上兜底监听。
    if ((props.mode ?? 'root') === 'root') {
      const target: EventTarget = resolvedRoot ?? window;

      // 用 passive 监听，避免在移动端拖慢滚动。
      target.addEventListener('scroll', checkByScroll, {
        passive: true,
      });

      detachScroll = () => {
        target.removeEventListener('scroll', checkByScroll);
      };
    }

    if (observer || typeof IntersectionObserver !== 'function') {
      return;
    }

    const mode = props.mode ?? 'root';

    observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) {
            // 离开视野后重新武装，支持「滚到底 → 加载 → 继续滚」的循环。
            if (!props.once) {
              fired = false;
            }
            continue;
          }

          // `root` 模式已由滚动兜底覆盖，这里只处理「哨兵自身进入视口」的场景。
          if (mode === 'viewport') {
            trigger();
          }
        }
      },
      {
        root: resolvedRoot,
        rootMargin: mode === 'root' ? (props.rootMargin ?? '0px') : '0px',
        threshold: typeof props.threshold === 'number' ? props.threshold : 0,
      }
    );

    observer.observe(sentinel);
  };

  return {
    sentinel,
    connect,
    destroy: () => {
      destroyed = true;
      detachScroll?.();
      detachScroll = null;
      observer?.disconnect();
      observer = null;
    },
    check: checkByScroll,
  };
};

export const Reach = defineEnhancedComponent(
  'Reach',
  (props: ReachProps): EnhancedRenderable => {
    const host = document.createElement('div');
    host.style.display = 'contents';

    appendRenderable(host, asRenderable(props.children));

    const controller = createReachController(props);
    host.appendChild(controller.sentinel);

    // 宿主插入文档后才可能解析到滚动祖先，因此挂载后再连接观察器。
    // 用一个短轮询代替 MutationObserver：只关心自身这一次挂载，代价更低。
    let attempts = 0;
    const tryConnect = (): void => {
      if (host.isConnected) {
        controller.connect();
        return;
      }

      attempts += 1;

      if (attempts < 30) {
        setTimeout(tryConnect, 16);
        return;
      }

      controller.destroy();
    };

    setTimeout(tryConnect, 0);

    // 页面卸载时释放，避免长生命周期页面里残留 observer。
    if (typeof window !== 'undefined') {
      const dispose = (): void => {
        controller.destroy();
        window.removeEventListener('pagehide', dispose);
      };

      window.addEventListener('pagehide', dispose);
    }

    return host;
  }
);
