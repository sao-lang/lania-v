import type {
  RenderBoundaryBindingPlan,
  RenderComponentBindingPlan,
  RenderConditionBindingPlan,
  RenderDynamicBindingPlan,
  RenderKeepAliveBindingPlan,
  RenderListBindingPlan,
  RenderTeleportBindingPlan,
  RenderTextBindingPlan,
  RenderTransitionBindingPlan,
} from '../../codegen/render';
import type { TemplateIRNode } from './types';

/**
 * 渲染绑定收集器。
 *
 * 这一层位于“模板 IR”与“render codegen plan”之间，职责是把树状 `TemplateIRNode`
 * 拆成若干按能力分组的线性绑定列表，例如：
 * - 文本绑定
 * - 列表绑定
 * - 组件绑定
 * - 条件/动态/Teleport/KeepAlive/Boundary/Transition 绑定
 *
 * 这样后续 `codegen/render/generate.ts` 就不需要边遍历整棵 IR 边生成代码，
 * 而是可以按类别批量生成 slot 声明、hoist 模板和 runtime updater。
 *
 * 这里最重要的价值是“拆树成表”：
 * 相同类型的绑定在这里被预先线性化之后，后续代码生成就能按类型做稳定的批处理，
 * 同时也避免把模板遍历逻辑散落到多个 codegen 分支中。
 */

// 收集普通文本插值绑定。只有 `ExpressionIR` 会直接产出 TextSlot 计划。
export const collectRenderTextBindings = (nodes: TemplateIRNode[]): RenderTextBindingPlan[] => {
  const bindings: RenderTextBindingPlan[] = [];

  nodes.forEach((node) => {
    if (node.type === 'ExpressionIR') {
      bindings.push({
        slotIndex: node.slotIndex,
        path: node.path,
        expression: node.expression,
      });
      return;
    }

    if (node.type === 'ElementIR') {
      // 元素自身不产生文本绑定，但其子树里可能继续包含文本 slot。
      bindings.push(...collectRenderTextBindings(node.children));
      return;
    }

    if (node.type === 'BoundaryIR' || node.type === 'TransitionIR') {
      // 边界节点内部依然有可递归收集的子树。
      bindings.push(...collectRenderTextBindings(node.children));
    }
  });

  return bindings;
};

// 收集 `ListIR` 绑定计划，包括 item/fallback/keyed item 模板等额外信息。
export const collectRenderListBindings = (nodes: TemplateIRNode[]): RenderListBindingPlan[] => {
  const bindings: RenderListBindingPlan[] = [];

  nodes.forEach((node) => {
    if (node.type === 'ListIR') {
      bindings.push({
        slotIndex: node.slotIndex,
        path: node.path,
        expression: node.expression,
        itemTemplateHtml: node.itemTemplateHtml,
        itemTemplateHoistName: node.itemTemplateHoistName,
        itemBindingsExpression: node.itemBindingsExpression,
        keyedItemTemplateHtml: node.keyedItemTemplateHtml,
        keyedItemHoistName: node.keyedItemHoistName,
        fallbackTemplateHtml: node.fallbackTemplateHtml,
        fallbackHoistName: node.fallbackHoistName,
      });
      return;
    }

    if (node.type === 'ElementIR') {
      bindings.push(...collectRenderListBindings(node.children));
      return;
    }

    if (node.type === 'BoundaryIR' || node.type === 'TransitionIR') {
      bindings.push(...collectRenderListBindings(node.children));
    }
  });

  return bindings;
};

// 收集静态组件占位计划；这些节点后续会变成 ComponentSlot 初始化代码。
export const collectRenderComponentBindings = (
  nodes: TemplateIRNode[]
): RenderComponentBindingPlan[] => {
  const bindings: RenderComponentBindingPlan[] = [];

  nodes.forEach((node) => {
    if (node.type === 'StaticComponentIR') {
      bindings.push({
        slotIndex: node.slotIndex,
        path: node.path,
        tagName: node.tagName,
        propsExpression: node.propsExpression,
      });
      return;
    }

    if (node.type === 'ElementIR') {
      bindings.push(...collectRenderComponentBindings(node.children));
      return;
    }

    if (node.type === 'BoundaryIR' || node.type === 'TransitionIR') {
      bindings.push(...collectRenderComponentBindings(node.children));
    }
  });

  return bindings;
};

// 收集 `IfIR` 计划，除了条件表达式，还要把 truthy/fallback 两边模板一起带走。
export const collectRenderConditionBindings = (
  nodes: TemplateIRNode[]
): RenderConditionBindingPlan[] => {
  const bindings: RenderConditionBindingPlan[] = [];

  nodes.forEach((node) => {
    if (node.type === 'IfIR') {
      bindings.push({
        slotIndex: node.slotIndex,
        path: node.path,
        expression: node.expression,
        mode: node.mode,
        templateHtml: node.templateHtml,
        hoistName: node.hoistName,
        children: node.children,
        fallbackTemplateHtml: node.fallbackTemplateHtml,
        fallbackHoistName: node.fallbackHoistName,
        fallbackChildren: node.fallbackChildren,
      });
      return;
    }

    if (node.type === 'ElementIR') {
      bindings.push(...collectRenderConditionBindings(node.children));
      return;
    }

    if (node.type === 'BoundaryIR' || node.type === 'TransitionIR') {
      bindings.push(...collectRenderConditionBindings(node.children));
    }
  });

  return bindings;
};

// 收集 Teleport 计划；目标表达式与子绑定描述都会在运行时重新使用。
export const collectRenderTeleportBindings = (
  nodes: TemplateIRNode[]
): RenderTeleportBindingPlan[] => {
  const bindings: RenderTeleportBindingPlan[] = [];

  nodes.forEach((node) => {
    if (node.type === 'TeleportIR') {
      bindings.push({
        slotIndex: node.slotIndex,
        path: node.path,
        targetExpression: node.targetExpression,
        templateHtml: node.templateHtml,
        hoistName: node.hoistName,
        children: node.children,
      });
      return;
    }

    if (node.type === 'ElementIR') {
      bindings.push(...collectRenderTeleportBindings(node.children));
      return;
    }

    if (node.type === 'BoundaryIR' || node.type === 'TransitionIR') {
      bindings.push(...collectRenderTeleportBindings(node.children));
    }
  });

  return bindings;
};

// 收集 Dynamic 计划；动态组件需要模板骨架、组件表达式和 props 表达式三者配合。
export const collectRenderDynamicBindings = (
  nodes: TemplateIRNode[]
): RenderDynamicBindingPlan[] => {
  const bindings: RenderDynamicBindingPlan[] = [];

  nodes.forEach((node) => {
    if (node.type === 'DynamicIR') {
      bindings.push({
        slotIndex: node.slotIndex,
        path: node.path,
        componentExpression: node.componentExpression,
        propsExpression: node.propsExpression,
        templateHtml: node.templateHtml,
        hoistName: node.hoistName,
        children: node.children,
      });
      return;
    }

    if (node.type === 'ElementIR') {
      bindings.push(...collectRenderDynamicBindings(node.children));
      return;
    }

    if (node.type === 'BoundaryIR' || node.type === 'TransitionIR') {
      bindings.push(...collectRenderDynamicBindings(node.children));
    }
  });

  return bindings;
};

// 收集 KeepAlive 计划；payload 表达式会驱动缓存命中与激活流程。
export const collectRenderKeepAliveBindings = (
  nodes: TemplateIRNode[]
): RenderKeepAliveBindingPlan[] => {
  const bindings: RenderKeepAliveBindingPlan[] = [];

  nodes.forEach((node) => {
    if (node.type === 'KeepAliveIR') {
      bindings.push({
        slotIndex: node.slotIndex,
        path: node.path,
        templateHtml: node.templateHtml,
        hoistName: node.hoistName,
        payloadExpression: node.payloadExpression,
        children: node.children,
      });
      return;
    }

    if (node.type === 'ElementIR') {
      bindings.push(...collectRenderKeepAliveBindings(node.children));
      return;
    }

    if (node.type === 'BoundaryIR' || node.type === 'TransitionIR') {
      bindings.push(...collectRenderKeepAliveBindings(node.children));
    }
  });

  return bindings;
};

// 收集 Transition 计划。和 Boundary 类似，但会额外保留 transition payload/fallback 信息。
export const collectRenderTransitionBindings = (
  nodes: TemplateIRNode[]
): RenderTransitionBindingPlan[] => {
  const bindings: RenderTransitionBindingPlan[] = [];

  nodes.forEach((node) => {
    if (node.type === 'TransitionIR') {
      bindings.push({
        slotIndex: node.slotIndex,
        path: node.path,
        componentName: node.componentName,
        templateHtml: node.templateHtml,
        hoistName: node.hoistName,
        payloadExpression: node.payloadExpression,
        fallbackTemplateHtml: node.fallbackTemplateHtml,
        fallbackHoistName: node.fallbackHoistName,
        children: node.children,
      });
      return;
    }

    if (node.type === 'ElementIR') {
      bindings.push(...collectRenderTransitionBindings(node.children));
      return;
    }

    if (
      node.type === 'IfIR' ||
      node.type === 'DynamicIR' ||
      node.type === 'TeleportIR' ||
      node.type === 'KeepAliveIR' ||
      node.type === 'BoundaryIR'
    ) {
      // 这些节点自身不是 TransitionIR，但内部 children 里仍可能嵌套出 transition 绑定。
      bindings.push(...collectRenderTransitionBindings(node.children ?? []));
      if (node.type === 'IfIR') {
        bindings.push(...collectRenderTransitionBindings(node.fallbackChildren ?? []));
      }
    }
  });

  return bindings;
};

export const collectRenderBoundaryBindings = (
  nodes: TemplateIRNode[]
): RenderBoundaryBindingPlan[] => {
  const bindings: RenderBoundaryBindingPlan[] = [];

  nodes.forEach((node) => {
    if (node.type === 'BoundaryIR') {
      // Boundary 计划会保留 fallback 模板与子绑定，供 block payload/hydration 两条路径复用。
      bindings.push({
        slotIndex: node.slotIndex,
        path: node.path,
        componentName: node.componentName,
        templateHtml: node.templateHtml,
        hoistName: node.hoistName,
        payloadExpression: node.payloadExpression,
        fallbackTemplateHtml: node.fallbackTemplateHtml,
        fallbackHoistName: node.fallbackHoistName,
        children: node.children,
      });
      return;
    }

    if (node.type === 'ElementIR') {
      bindings.push(...collectRenderBoundaryBindings(node.children));
      return;
    }

    if (
      node.type === 'IfIR' ||
      node.type === 'DynamicIR' ||
      node.type === 'TeleportIR' ||
      node.type === 'KeepAliveIR' ||
      node.type === 'TransitionIR'
    ) {
      // 同理，Boundary 也可能嵌套在其他 block 节点的 children/fallback 子树里。
      bindings.push(...collectRenderBoundaryBindings(node.children ?? []));
      if (node.type === 'IfIR') {
        bindings.push(...collectRenderBoundaryBindings(node.fallbackChildren ?? []));
      }
    }
  });

  return bindings;
};
