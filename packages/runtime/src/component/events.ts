/**
 * 事件系统与事件委托（delegation）。
 *
 * 这里统一处理三件事：
 * 1. 把模板/JSX 中的事件名解析成 DOM 事件或组件事件，并拆出修饰符；
 * 2. 为常见 DOM 事件提供可选的委托监听机制，减少逐节点直绑的成本；
 * 3. 在真正触发 handler 前执行 stop / prevent / self / 键盘键位 / 系统键等修饰符过滤。
 *
 * 整体目标是让“事件名解析”“监听挂载”“修饰符执行”三个阶段解耦，便于模板层与 JSX 层共用。
 * 另外，委托实现刻意把“根节点注册”“冒泡路径回放”“按目标节点分发表”拆成三个步骤，
 * 以便在 ShadowRoot、普通 DOM 树和组件宿主之间保持一致的监听语义。
 */

export type EventModifier =
  | 'stop'
  | 'prevent'
  | 'self'
  | 'enter'
  | `key:${string}`
  | `system:${'ctrl' | 'shift' | 'alt' | 'meta'}`
  | (string & {});

export interface ParsedEventBindingName {
  kind: 'dom-event' | 'component-event';
  sourceName: string;
  eventName: string;
  modifiers: EventModifier[];
}

export type EventModifierHandler = (event: Event) => boolean | void;
export type DelegatedEventHandler = (event: Event) => void;

interface DelegatedEventBucket {
  listener: EventListener;
  bindings: WeakMap<EventTarget, Set<DelegatedEventHandler>>;
  size: number;
}

const delegatedRoots = new WeakSet<EventTarget>();
const delegatedBuckets = new WeakMap<
  EventTarget,
  Map<string, DelegatedEventBucket>
>();

const findDelegationRoot = (node: Node): EventTarget | null => {
  let current: Node | null = node;

  while (current) {
    if (delegatedRoots.has(current)) {
      return current;
    }

    current =
      current.parentNode ??
      (current instanceof ShadowRoot ? current.host : null);
  }

  const root = node.getRootNode();
  // 跨 ShadowRoot 时退回逻辑根节点继续判断，保持组件树内的事件委托一致性。
  return delegatedRoots.has(root) ? root : null;
};

export const DOM_EVENT_NAMES = new Set([
  'click',
  'input',
  'change',
  'keydown',
  'keyup',
  'keypress',
  'submit',
  'focus',
  'blur',
  'pointerdown',
  'pointerup',
]);

const KEYBOARD_EVENT_NAMES = new Set(['keydown', 'keyup', 'keypress']);
const EVENT_SYSTEM_MODIFIERS = new Set(['ctrl', 'shift', 'alt', 'meta']);
const isPotentialDomEventName = (name: string): boolean => {
  return /^[a-z][a-z0-9:-]*$/.test(name);
};

const normalizeParsedEventModifiers = (
  eventName: string,
  modifiers: readonly string[]
): EventModifier[] => {
  return modifiers.map((modifier) => {
    const lowerModifier = modifier.toLowerCase();

    if (EVENT_SYSTEM_MODIFIERS.has(lowerModifier)) {
      return `system:${lowerModifier}` as EventModifier;
    }

    if (
      KEYBOARD_EVENT_NAMES.has(eventName) &&
      !['stop', 'prevent', 'self', 'enter'].includes(lowerModifier) &&
      !lowerModifier.startsWith('key:') &&
      !lowerModifier.startsWith('system:')
    ) {
      return `key:${lowerModifier}` as EventModifier;
    }

    return lowerModifier as EventModifier;
  });
};

const getDelegationPath = (event: Event, root: EventTarget): EventTarget[] => {
  const path =
    typeof event.composedPath === 'function'
      ? event.composedPath().filter((target): target is EventTarget => target instanceof EventTarget)
      : [];

  if (path.length > 0) {
    // 优先信任原生 composedPath，这样跨 ShadowRoot 时能保留浏览器已经解析好的真实传播路径。
    return path;
  }

  const targets: EventTarget[] = [];
  let current = event.target;

  while (current instanceof Node) {
    targets.push(current);

    if (current === root) {
      break;
    }

    current = current.parentNode;
  }

  return targets;
};

const dispatchDelegatedEvent = (
  root: EventTarget,
  eventName: string,
  event: Event
): void => {
  const rootBuckets = delegatedBuckets.get(root);
  const bucket = rootBuckets?.get(eventName);

  if (!bucket) {
    return;
  }

  for (const target of getDelegationPath(event, root)) {
    const handlers = bucket.bindings.get(target);

    if (!handlers) {
      continue;
    }

    for (const handler of handlers) {
      // 按事件传播路径逐层触发，语义上接近原生冒泡。
      handler(event);

      if (event.cancelBubble) {
        return;
      }
    }
  }
};

export const enableEventDelegation = (root: EventTarget): void => {
  delegatedRoots.add(root);
};

export const disableEventDelegation = (root: EventTarget): void => {
  delegatedRoots.delete(root);
  const rootBuckets = delegatedBuckets.get(root);

  if (!rootBuckets) {
    return;
  }

  rootBuckets.forEach((bucket, eventName) => {
    root.removeEventListener(eventName, bucket.listener);
  });
  rootBuckets.clear();
};

export const shouldUseDelegatedEventListener = (
  node: EventTarget,
  eventName: string,
  options?: AddEventListenerOptions
): boolean => {
  // 只在白名单事件且未显式传 options 时启用委托，避免 passive/capture/once 语义丢失。
  if (!(node instanceof Node) || !DOM_EVENT_NAMES.has(eventName) || options) {
    return false;
  }

  return findDelegationRoot(node) !== null;
};

export const attachDelegatedEventListener = (
  node: EventTarget,
  eventName: string,
  handler: DelegatedEventHandler
): boolean => {
  if (!(node instanceof Node)) {
    return false;
  }

  const root = findDelegationRoot(node);

  if (!root) {
    return false;
  }

  let rootBuckets = delegatedBuckets.get(root);

  if (!rootBuckets) {
    rootBuckets = new Map();
    delegatedBuckets.set(root, rootBuckets);
  }

  let bucket = rootBuckets.get(eventName);

  if (!bucket) {
    // 同一个 root + eventName 只挂一条原生监听，再把实际 handler 分发到各个目标节点。
    const listener: EventListener = (event) => {
      dispatchDelegatedEvent(root, eventName, event);
    };
    bucket = {
      listener,
      bindings: new WeakMap(),
      size: 0,
    };
    rootBuckets.set(eventName, bucket);
    root.addEventListener(eventName, listener);
  }

  const currentHandlers = bucket.bindings.get(node) ?? new Set<DelegatedEventHandler>();
  // 一个节点同一事件名下允许挂多个运行时 handler，委托层只维护目标节点到 handler 集合的映射。
  currentHandlers.add(handler);
  bucket.bindings.set(node, currentHandlers);
  bucket.size += 1;
  return true;
};

export const detachDelegated = (
  node: EventTarget,
  eventName: string,
  handler: DelegatedEventHandler
): boolean => {
  if (!(node instanceof Node)) {
    return false;
  }

  const root = findDelegationRoot(node);

  if (!root) {
    return false;
  }

  const rootBuckets = delegatedBuckets.get(root);
  const bucket = rootBuckets?.get(eventName);

  if (!bucket) {
    return false;
  }

  const currentHandlers = bucket.bindings.get(node);

  if (!currentHandlers?.has(handler)) {
    return false;
  }

  currentHandlers.delete(handler);
  bucket.size -= 1;

  if (currentHandlers.size === 0) {
    bucket.bindings.delete(node);
  }

  if (bucket.size === 0) {
    // 当前 root 上这个事件名已经没有任何目标节点在使用，及时释放原生监听。
    root.removeEventListener(eventName, bucket.listener);
    rootBuckets?.delete(eventName);
  }

  if (rootBuckets && rootBuckets.size === 0) {
    delegatedBuckets.delete(root);
  }

  return true;
};

const isKeyboardEvent = (event: Event): event is KeyboardEvent => {
  return 'key' in event;
};

export const EVENT_MODIFIER_HANDLERS: Record<string, EventModifierHandler> = {
  stop(event) {
    event.stopPropagation();
    return true;
  },
  prevent(event) {
    event.preventDefault();
    return true;
  },
  self(event) {
    return event.target === event.currentTarget;
  },
  enter(event) {
    return isKeyboardEvent(event) ? event.key === 'Enter' : false;
  },
};

const matchesKeyModifier = (event: Event, modifier: EventModifier): boolean => {
  if (!modifier.startsWith('key:') || !isKeyboardEvent(event)) {
    return true;
  }

  const expected = modifier.slice(4).toLowerCase();
  const actual = String(event.key ?? '').toLowerCase();
  return actual === expected;
};

const matchesSystemModifier = (event: Event, modifier: EventModifier): boolean => {
  if (!modifier.startsWith('system:')) {
    return true;
  }

  const key = `${modifier.slice('system:'.length)}Key`;
  return Boolean((event as unknown as Record<string, unknown>)[key]);
};

export const parseEventBindingName = (
  sourceName: string
): ParsedEventBindingName | null => {
  if (sourceName.startsWith('on:')) {
    // `on:` 前缀保留给组件事件，事件是否真正被消费由组件自身决定。
    const descriptor = sourceName.slice(3);
    const [eventName, ...modifiers] = descriptor.split('.');
    return {
      kind: 'component-event',
      sourceName,
      eventName,
      modifiers: normalizeParsedEventModifiers(eventName, modifiers),
    };
  }

  const [eventName, ...modifiers] = sourceName.split('.');

  if (!DOM_EVENT_NAMES.has(eventName) && !(modifiers.length > 0 && isPotentialDomEventName(eventName))) {
    return null;
  }

  // 纯 DOM 事件既支持白名单名，也允许在带修饰符时解析诸如 `scroll.passive` 这样的扩展写法。
  return {
    kind: 'dom-event',
    sourceName,
    eventName,
    modifiers: normalizeParsedEventModifiers(eventName, modifiers),
  };
};

export const withEventModifiers = <TEvent extends Event = Event>(
  handler: ((event: TEvent) => unknown) | null | undefined,
  modifiers: readonly EventModifier[]
): ((event: TEvent) => void) | null => {
  if (!handler) {
    return null;
  }

  return (event: TEvent) => {
    for (const modifier of modifiers) {
      // 过滤型修饰符先跑，命中失败就不再触发后续副作用型修饰符与用户 handler。
      // 键盘键位和系统键先作为过滤条件；不匹配时直接短路。
      if (!matchesKeyModifier(event, modifier) || !matchesSystemModifier(event, modifier)) {
        return;
      }

      const guard = EVENT_MODIFIER_HANDLERS[modifier];

      if (!guard) {
        continue;
      }

      const passed = guard(event);

      if (passed === false) {
        return;
      }
    }

    handler(event);
  };
};
