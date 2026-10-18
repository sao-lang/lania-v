import {
  getEnhancedComponentRegistryEntry,
  type BoundaryPayloadComponentName,
  type TransitionPayloadComponentName,
} from '@lania-v/shared';
import type { ElementNode } from '../../../ast';
import {
  buildBoundaryPayloadExpression,
  buildRuntimePropsExpression,
  buildTransitionPayloadExpression,
} from '../helpers/payload';
import {
  getAttributeExpression,
  getAttributeStringValue,
  renderStaticTemplateFromExpression,
} from '../helpers/template-helpers';
import { lowerEachElement, lowerSwitchElement, lowerWhenElement } from './lower-conditions';
import {
  lowerDynamicElement,
  lowerKeepAliveElement,
  lowerTeleportElement,
} from './lower-dynamic';
import type {
  DynamicIR,
  LowerEnhancedComponentContext,
  LowerTemplateOptions,
  LowerTemplateResult,
  TemplateLowerer,
} from '../types';

/**
 * enhanced component / boundary 系 lowering。
 *
 * 这里集中处理一类“看上去像普通组件标签，但编译期已知带有特殊运行时语义”的节点，
 * 包括 `Transition`、`Boundary`、`When` / `Switch`、`Each`、`Teleport` 等。
 *
 * 这一层的核心职责不是直接生成代码，而是把这些语义节点压成更明确的 IR：
 * - block 类节点会被分配独立 slot 占位；
 * - 子树静态 HTML 会被提取成模板壳；
 * - 运行时真正需要的 payload、fallback 和 child binding 线索会在此阶段收齐。
 *
 * 它相当于模板 lowering 里的“特殊节点分发器”：
 * 先识别当前标签是否属于 enhanced component，再根据其渲染模式决定
 * 是扁平展开、保留成动态块，还是压成带 payload 的 boundary/transition IR。
 */
const isTransitionPayloadComponentName = (
  componentName: string
): componentName is TransitionPayloadComponentName => {
  return componentName === 'Transition' || componentName === 'TransitionGroup';
};

const getTransitionPayloadComponentConfig = (
  componentName: TransitionPayloadComponentName
): {
  tagPropName?: 'tag';
} => {
  // 只有部分过渡组件需要额外读取包装标签配置。
  return componentName === 'TransitionGroup' ? { tagPropName: 'tag' } : {};
};

const createSingleSlotLoweringResult = (
  node: LowerTemplateResult['nodes'][number],
  slotIndex: number,
  nextBoundaryIndex: number
): LowerTemplateResult => {
  // 若某个特殊节点本身只占一个 slot，这里把通用返回结构封装成统一形态。
  return {
    nodes: [node],
    staticHtml: `<!--__LANIA_SLOT_${slotIndex}__-->`,
    nextSlotIndex: slotIndex + 1,
    nextBoundaryIndex,
    renderedRootCount: 1,
  };
};

const lowerChildrenOnlyBoundaryAsDynamic = (
  child: ElementNode,
  path: number[],
  slotIndex: number,
  boundaryIndex: number,
  lowerTemplateChildren: TemplateLowerer
): LowerTemplateResult | null => {
  if (!isTransitionPayloadComponentName(child.tagName)) {
    return null;
  }

  // children-only 组件在特定场景下不能被静态扁平化，需要保留成动态块占位。
  const template = lowerTemplateChildren(child.children, [], 0, boundaryIndex + 1, 0, {
    preserveChildrenOnlyEnhancedAsDynamic: true,
  });
  const payloadExpression = buildTransitionPayloadExpression(child, child.tagName, {
    transitionIndex: boundaryIndex,
    childTemplateHtml: template.staticHtml,
  });
  const runtimePropsExpression = buildRuntimePropsExpression(child, ['props']);
  const transitionConfig = getTransitionPayloadComponentConfig(child.tagName);
  // 某些过渡组件还需要把包装标签一并带给 SSR / hydration。
  const transitionTagExpression = transitionConfig.tagPropName
    ? getAttributeExpression(child, transitionConfig.tagPropName) ??
      (getAttributeStringValue(child, transitionConfig.tagPropName)
        ? JSON.stringify(getAttributeStringValue(child, transitionConfig.tagPropName))
        : undefined)
    : undefined;
  const dynamicNode: DynamicIR = {
    type: 'DynamicIR',
    path,
    slotIndex,
    componentExpression: JSON.stringify(child.tagName),
    propsExpression: `({ ...(${runtimePropsExpression}), payload: ${payloadExpression} })`,
    templateHtml: template.staticHtml,
    hoistName: `__dynamic_slot_${path.join('_') || 'root'}_${slotIndex}`,
    enhancedComponentName: child.tagName,
    ssrWrapperTagExpression: transitionTagExpression,
    children: template.nodes,
  };

  // 这里虽然保留了过渡组件的协议数据，但节点外形统一退成 DynamicIR，便于后续共用动态 codegen。
  // 这里虽然语义上来自 Transition/TransitionGroup，但 IR 形态退化成 DynamicIR 更便于后续统一处理。
  return {
    nodes: [dynamicNode],
    staticHtml: `<!--__LANIA_SLOT_${slotIndex}__-->`,
    nextSlotIndex: slotIndex + 1,
    nextBoundaryIndex: template.nextBoundaryIndex,
    renderedRootCount: 1,
  };
};

const lowerTransitionElement = (
  child: ElementNode,
  path: number[],
  parentPath: number[],
  nextSlotIndex: number,
  transitionIndex: number,
  domIndex: number,
  lowerTemplateChildren: TemplateLowerer
): LowerTemplateResult => {
  // 过渡块的 children 会被提取成独立模板，路径同样必须相对模板根重新起算。
  const loweredChildren = lowerTemplateChildren(
    child.children,
    [],
    nextSlotIndex,
    transitionIndex + 1,
    0
  );
  const fallbackExpression = getAttributeExpression(child, 'fallback');
  const fallbackTemplateHtml = fallbackExpression
    ? renderStaticTemplateFromExpression(fallbackExpression) ?? undefined
    : undefined;
  const slotIndex = nextSlotIndex;
  // TransitionIR 负责占住 block slot；真实 child 结构则继续保存在 `children` 中供 payload/codegen 复用。
  const transitionNode = {
    type: 'TransitionIR' as const,
    path,
    slotIndex,
    transitionIndex,
    componentName: child.tagName as TransitionPayloadComponentName,
    templateHtml: loweredChildren.staticHtml,
    hoistName: `__transition_slot_${path.join('_') || 'root'}_${slotIndex}`,
    payloadExpression: buildTransitionPayloadExpression(
      child,
      child.tagName as TransitionPayloadComponentName,
      {
        transitionIndex,
        childTemplateHtml: loweredChildren.staticHtml,
        fallbackTemplateHtml,
      }
    ),
    fallbackTemplateHtml,
    fallbackHoistName: fallbackTemplateHtml
      ? `__transition_fallback_slot_${path.join('_') || 'root'}_${slotIndex}`
      : undefined,
    children: loweredChildren.nodes,
  };

  return {
    nodes: [transitionNode],
    staticHtml: `<!--__LANIA_SLOT_${slotIndex}__-->`,
    nextSlotIndex: slotIndex + 1,
    nextBoundaryIndex: loweredChildren.nextBoundaryIndex,
    renderedRootCount: 1,
  };
};

const lowerBoundaryElement = (
  child: ElementNode,
  path: number[],
  parentPath: number[],
  nextSlotIndex: number,
  boundaryIndex: number,
  domIndex: number,
  lowerTemplateChildren: TemplateLowerer
): LowerTemplateResult => {
  // Boundary 同样先降子树，再把错误边界所需运行时上下文打包进 payload。
  // 子树会被提取成独立的 child template，因此路径必须相对该模板根重新起算，
  // 否则运行时按父模板坐标（如 [0, 2]）去 child template 里找节点必然失败。
  const loweredChildren = lowerTemplateChildren(
    child.children,
    [],
    nextSlotIndex,
    boundaryIndex + 1,
    0
  );
  const fallbackExpression = getAttributeExpression(child, 'fallback');
  const fallbackTemplateHtml = fallbackExpression
    ? renderStaticTemplateFromExpression(fallbackExpression) ?? undefined
    : undefined;
  const slotIndex = nextSlotIndex;
  // BoundaryIR 与 TransitionIR 的壳子很像，但运行时协议会走边界恢复/报错兜底逻辑。
  const boundaryNode = {
    type: 'BoundaryIR' as const,
    path,
    slotIndex,
    boundaryIndex,
    componentName: child.tagName,
    templateHtml: loweredChildren.staticHtml,
    hoistName: `__boundary_slot_${path.join('_') || 'root'}_${slotIndex}`,
    payloadExpression: buildBoundaryPayloadExpression(
      child,
      child.tagName as BoundaryPayloadComponentName,
      {
        boundaryIndex,
        childTemplateHtml: loweredChildren.staticHtml,
        fallbackTemplateHtml,
      }
    ),
    fallbackTemplateHtml,
    fallbackHoistName: fallbackTemplateHtml
      ? `__boundary_fallback_slot_${path.join('_') || 'root'}_${slotIndex}`
      : undefined,
    children: loweredChildren.nodes,
  };

  return {
    nodes: [boundaryNode],
    staticHtml: `<!--__LANIA_SLOT_${slotIndex}__-->`,
    nextSlotIndex: slotIndex + 1,
    nextBoundaryIndex: loweredChildren.nextBoundaryIndex,
    renderedRootCount: 1,
  };
};

export const lowerEnhancedComponent = (
  context: LowerEnhancedComponentContext,
  lowerTemplateChildren: TemplateLowerer,
  options: LowerTemplateOptions = {}
): LowerTemplateResult | null => {
  // 是否属于已注册的 enhanced component，决定是否进入特殊 lowering 分支。
  const enhancedEntry = getEnhancedComponentRegistryEntry(context.child.tagName);

  if (!enhancedEntry) {
    return null;
  }

  if (
    enhancedEntry.staticRenderMode === 'children-only' &&
    options.preserveChildrenOnlyEnhancedAsDynamic
  ) {
    // 某些父级场景要求 children-only 节点保持动态边界，而不是被完全摊平。
    const loweredChildrenOnlyDynamic = lowerChildrenOnlyBoundaryAsDynamic(
      context.child,
      context.path,
      context.slotIndex,
      context.boundaryIndex,
      lowerTemplateChildren
    );
    if (loweredChildrenOnlyDynamic) {
      return loweredChildrenOnlyDynamic;
    }
  }

  if (enhancedEntry.staticRenderMode === 'flatten') {
    // `flatten` 模式直接把子节点并入当前父级，不额外生成 slot 壳。
    return lowerTemplateChildren(
      context.child.children,
      context.parentPath,
      context.slotIndex,
      context.boundaryIndex,
      context.domIndex,
      options
    );
  }

  switch (enhancedEntry.irKind as string) {
    case 'KeepAliveIR':
      // KeepAlive 本身不消耗新的 boundary 计数，只把模板块包装成一个缓存 slot。
      return createSingleSlotLoweringResult(
        lowerKeepAliveElement(
          context.child,
          context.path,
          context.slotIndex,
          lowerTemplateChildren
        ),
        context.slotIndex,
        context.boundaryIndex
      );
    case 'TransitionIR':
      return lowerTransitionElement(
        context.child,
        context.path,
        context.parentPath,
        context.slotIndex,
        context.boundaryIndex,
        context.domIndex,
        lowerTemplateChildren
      );
    case 'BoundaryIR':
      return lowerBoundaryElement(
        context.child,
        context.path,
        context.parentPath,
        context.slotIndex,
        context.boundaryIndex,
        context.domIndex,
        lowerTemplateChildren
      );
    case 'IfIR': {
      // `Switch` 与 `When` 最终都进入条件块 IR，只是前置解析规则不同。
      const whenNode =
        context.child.tagName === 'Switch'
          ? lowerSwitchElement(
              context.child,
              context.path,
              context.slotIndex,
              lowerTemplateChildren
            )
          : lowerWhenElement(
              context.child,
              context.path,
              context.slotIndex,
              lowerTemplateChildren
            );
      return whenNode
        ? createSingleSlotLoweringResult(whenNode, context.slotIndex, context.boundaryIndex)
        : null;
    }
    case 'ListIR': {
      // 列表节点在 lowering 时就折叠成一个独立 block slot。
      const eachNode = lowerEachElement(context.child, context.path, context.slotIndex);
      return eachNode
        ? createSingleSlotLoweringResult(eachNode, context.slotIndex, context.boundaryIndex)
        : null;
    }
    case 'DynamicIR': {
      // 动态组件、组件引用和别名组件统一由动态 lowering 分支处理。
      const dynamicNode = lowerDynamicElement(
        context.child,
        context.path,
        context.slotIndex,
        lowerTemplateChildren
      );
      return dynamicNode
        ? createSingleSlotLoweringResult(dynamicNode, context.slotIndex, context.boundaryIndex)
        : null;
    }
    case 'TeleportIR': {
      // Teleport 虽然也是 block slot，但目标容器表达式与普通动态块不同。
      const teleportNode = lowerTeleportElement(
        context.child,
        context.path,
        context.slotIndex,
        lowerTemplateChildren
      );
      return teleportNode
        ? createSingleSlotLoweringResult(teleportNode, context.slotIndex, context.boundaryIndex)
        : null;
    }
    default:
      return null;
  }
};
