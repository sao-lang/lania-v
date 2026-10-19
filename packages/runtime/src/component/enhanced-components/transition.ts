/**
 * 增强过渡组件入口。
 *
 * 该文件负责把声明式 `Transition` / `TransitionGroup` props 收敛成共享协议 payload，
 * 再分别交给单节点过渡宿主和列表过渡注册表处理。这里本身不实现动画细节，只负责：
 * - 组装 runtime 可识别的 phase / hook / key 元数据；
 * - 读取兼容层 update host，接入已有 DOM 调度环境；
 * - 把 children 规范化为 renderable 或 renderable 列表后转交底层实现。
 */
import {
  ENHANCED_CONTRACT_PROTOCOL,
  ENHANCED_CONTRACT_VERSION,
  type TransitionPayload,
} from '@lania-v/shared';
import { renderGroup } from '../transition/group-registry';
import { renderTransition } from '../transition/host';
import { getTransitionState } from '../transition/registry';
import { defineEnhancedComponent } from './utils/factory';
import { readCompatUpdateHost } from './utils/compat';
import {
  asRenderable,
  collectRenderableNodes,
  getRenderableElements,
  hasRenderableContent,
  invokeRenderable,
  toRenderableArray,
} from './utils/renderable';
import type {
  EnhancedComponentDefinition,
  EnhancedRenderable,
  TransitionGroupProps,
  TransitionProps,
} from './types';

const createTransitionPayload = (
  component: TransitionPayload['component'],
  options: {
    name?: string;
    key?: PropertyKey | null;
    tag?: string;
    hooks?: TransitionPayload['transition']['hooks'];
  }
): TransitionPayload => {
  // Transition 与 TransitionGroup 共用一份 payload 生成逻辑，只在 phase / keyProp 上分流。
  return {
    protocol: ENHANCED_CONTRACT_PROTOCOL,
    version: ENHANCED_CONTRACT_VERSION,
    payloadKind: 'transition',
    component,
    irKind: 'TransitionIR',
    transitionIndex: 0,
    transition: {
      name: options.name,
      key: options.key,
      keyProp: component === 'TransitionGroup' ? 'groupKey' : 'transitionKey',
      tag: options.tag,
      phases:
        component === 'TransitionGroup'
          ? ['appear', 'enter', 'move', 'leave']
          : ['appear', 'enter', 'leave'],
      hooks: options.hooks,
    },
  };
};

const resolveTransitionPayload = (props: TransitionProps): TransitionPayload => {
  return (
    props.payload ??
    createTransitionPayload('Transition', {
      name: props.name,
      key: props.transitionKey,
      hooks: {
        appear: props.appear,
        enter: props.enter,
        leave: props.leave,
        onAppear: props.onAppear,
        onEnter: props.onEnter,
        onLeave: props.onLeave,
      },
    })
  );
};

const resolveTransitionGroupPayload = (
  props: TransitionGroupProps
): TransitionPayload => {
  return (
    props.payload ??
    createTransitionPayload('TransitionGroup', {
      name: props.name,
      key: props.groupKey,
      tag: props.tag,
      hooks: {
        appear: props.appear,
        enter: props.enter,
        leave: props.leave,
        move: props.move,
        onAppear: props.onAppear,
        onEnter: props.onEnter,
        onLeave: props.onLeave,
        onMove: props.onMove,
      },
    })
  );
};

const resolveTransitionStateKey = (props: TransitionProps): string =>
  String(props.transitionKey ?? props.name ?? 'default');

/**
 * 离场快照会短暂停留在同一段 DOM 区间里，但它已经不再属于“当前 children”。
 * 如果不过滤，内部 slot 下次从 DOM 同步节点时会把快照当成新内容读回来：
 * 隐去时误判为“又有内容”触发 enter，重新显示时又会把旧节点一并渲染，导致节点累积。
 */
const pruneLeavingNodes = (
  rendered: EnhancedRenderable,
  leavingSnapshot: unknown
): EnhancedRenderable => {
  if (leavingSnapshot == null) {
    return rendered;
  }

  const leavingNodes = new Set(collectRenderableNodes(leavingSnapshot as EnhancedRenderable));
  if (leavingNodes.size === 0) {
    return rendered;
  }

  const remaining = toRenderableArray(rendered).filter(
    (entry) => !(entry instanceof Node && leavingNodes.has(entry))
  );

  if (remaining.length === 0) {
    return null;
  }

  return remaining.length === 1 ? remaining[0]! : remaining;
};

export const Transition: EnhancedComponentDefinition<
  'Transition',
  TransitionProps,
  EnhancedRenderable
> = defineEnhancedComponent(
  'Transition',
  (props: TransitionProps): EnhancedRenderable => {
    const rendered = invokeRenderable(asRenderable(props.children));
    const previous = getTransitionState(resolveTransitionStateKey(props));
    const pruned = previous?.leaving
      ? pruneLeavingNodes(rendered, previous.snapshot)
      : rendered;
    const host = readCompatUpdateHost();
    const { result } = renderTransition<EnhancedRenderable>({
      payload: resolveTransitionPayload(props),
      // 单节点过渡用“是否有可渲染内容”推导显隐状态，供 enter / leave 判定。
      visible: hasRenderableContent(pruned),
      rendered: pruned,
      host,
      getElements: getRenderableElements,
    });
    return result;
  }
);

export const TransitionGroup = defineEnhancedComponent(
  'TransitionGroup',
  (props: TransitionGroupProps): EnhancedRenderable => {
    const host = readCompatUpdateHost();
    const { result } = renderGroup<EnhancedRenderable>({
      payload: resolveTransitionGroupPayload(props),
      host,
      getElements: getRenderableElements,
      // group 每次都重新读取 children，保证 keyed diff 基于最新列表执行。
      renderEntries: () =>
        toRenderableArray(invokeRenderable(asRenderable(props.children))),
      explicitKeys: props.keys,
    });
    return result;
  }
);
