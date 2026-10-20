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
  | 'passive'
  | 'immediate'
  | 'left'
  | 'middle'
  | 'right'
  | 'prevent:self'
  | 'prevent:immediate'
  | `key:${string}`
  | `system:${'ctrl' | 'shift' | 'alt' | 'meta'}`
  | `button:${'left' | 'middle' | 'right'}`
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
const EVENT_MOUSE_BUTTONS = new Set(['left', 'middle', 'right']);
// 这些修饰符带副作用或需要引擎额外支持，不能按键盘键位兜底解析。
const EVENT_RESERVED_MODIFIERS = new Set([
  'stop',
  'prevent',
  'self',
  'enter',
  'passive',
  'immediate',
  'once',
  'capture',
]);
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

    if (EVENT_MOUSE_BUTTONS.has(lowerModifier)) {
      return `button:${lowerModifier}` as EventModifier;
    }

    if (
      KEYBOARD_EVENT_NAMES.has(eventName) &&
      !EVENT_RESERVED_MODIFIERS.has(lowerModifier) &&
      !lowerModifier.startsWith('key:') &&
      !lowerModifier.startsWith('system:') &&
      !lowerModifier.startsWith('button:')
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
  'prevent:self'(event) {
    // 只在“事件由当前节点自己触发”时阻止默认行为，避免父节点绑定影响子节点。
    if (event.target === event.currentTarget) {
      event.preventDefault();
    }
    return true;
  },
  'prevent:immediate'(event) {
    event.preventDefault();
    event.stopImmediatePropagation();
    return true;
  },
  self(event) {
    return event.target === event.currentTarget;
  },
  enter(event) {
    return isKeyboardEvent(event) ? event.key === 'Enter' : false;
  },
  immediate(event) {
    event.stopImmediatePropagation();
    return true;
  },
  passive() {
    // passive 只是提示性标记：真正的监听选项由 EventSlot 透传给 addEventListener。
    return true;
  },
};

const isMouseEventLike = (event: Event): boolean => {
  return 'button' in event;
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

const MOUSE_BUTTON_INDEX: Record<string, number> = {
  left: 0,
  middle: 1,
  right: 2,
};

const matchesButtonModifier = (event: Event, modifier: EventModifier): boolean => {
  if (!modifier.startsWith('button:')) {
    return true;
  }

  const expected = MOUSE_BUTTON_INDEX[modifier.slice('button:'.length)];
  if (expected === undefined || !isMouseEventLike(event)) {
    return true;
  }

  return (event as MouseEvent).button === expected;
};

/**
 * 过滤型修饰符统一在真正执行副作用前判定，任一不满足就短路后续修饰符与 handler。
 * `enter` 保留原有“匹配时放行、不匹配时拦截”的行为，因此单独处理。
 */
const matchesEventFilter = (event: Event, modifier: EventModifier): boolean => {
  if (modifier === 'self') {
    return event.target === event.currentTarget;
  }

  if (modifier === 'enter') {
    // `enter` 不以 `key:` 前缀出现，需要单独映射到键位过滤，否则对象写法会丢失拦截语义。
    return matchesKeyModifier(event, 'key:enter');
  }

  return (
    matchesKeyModifier(event, modifier) &&
    matchesSystemModifier(event, modifier) &&
    matchesButtonModifier(event, modifier)
  );
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
      // 键盘键位、系统键、鼠标键都先作为过滤条件；不匹配时直接短路。
      if (!matchesEventFilter(event, modifier)) {
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

export type EventHint = 'debounce' | 'throttle' | (string & {});

export interface EventHintOptions {
  debounceMs?: number;
  throttleMs?: number;
}

const DEFAULT_EVENT_HINT_MS = 16;

const readEventHintDelay = (
  hint: EventHint,
  options?: EventHintOptions
): number => {
  if (hint === 'debounce') {
    return options?.debounceMs ?? DEFAULT_EVENT_HINT_MS;
  }

  return options?.throttleMs ?? DEFAULT_EVENT_HINT_MS;
};

/**
 * 把 `.debounce` / `.throttle` 等“提示性修饰符”落成运行时处理器。
 * 编译期只负责识别并把这些修饰符从过滤链中摘出，真正的包装逻辑集中在这里。
 *
 * 每次调度都会包一层 `withEventModifiers`，确保过滤型修饰符继续生效；
 * 同名的交互因合并到同一个排队任务而只触发最后一次（debounce）。
 */
export const withEventHint = <TEvent extends Event = Event>(
  handler: ((event: TEvent) => unknown) | null | undefined,
  hint: EventHint,
  modifiers: readonly EventModifier[] = [],
  options?: EventHintOptions
): ((event: TEvent) => void) | null => {
  if (!handler) {
    return null;
  }

  const delay = readEventHintDelay(hint, options);
  let timer: ReturnType<typeof setTimeout> | null = null;
  let lastEvent: TEvent | null = null;

  const invoke = (event: TEvent): void => {
    withEventModifiers(handler, modifiers)?.(event);
  };

  const flush = (): void => {
    timer = null;
    const pending = lastEvent;
    lastEvent = null;

    if (pending) {
      invoke(pending);
    }
  };

  const schedule = (): void => {
    if (timer) {
      clearTimeout(timer);
    }

    timer = setTimeout(flush, delay);
  };

  return (event: TEvent) => {
    lastEvent = event;

    if (hint === 'throttle') {
      // 节流窗口内只保留最新一次事件，窗口结束时补发。
      if (!timer) {
        invoke(event);
        lastEvent = null;
        schedule();
      }
      return;
    }

    schedule();
  };
};
