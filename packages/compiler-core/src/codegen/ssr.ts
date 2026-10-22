import type {
  BoundaryIR,
  ComponentIR,
  DynamicAttributeIR,
  ElementIR,
  ListIR,
  TemplateIRNode,
  TransitionIR,
} from '../ir/component';
import {
  doesTransitionPayloadComponentUseSsrWrapperTag,
  isSuspenseBoundaryComponentName,
  isTransitionPayloadComponentName,
} from '@lania-v/shared';

/**
 * SSR 代码生成。
 *
 * 这个模块的职责是把模板 IR 映射为“可直接执行的服务端渲染表达式”。
 * 与 CSR 不同，SSR 关注的是字符串拼接和边界输出，因此这里主要做三件事：
 * - 把静态节点直接转成字符串字面量；
 * - 把动态节点包装成 SSR runtime helper 调用；
 * - 同时产出同步 `render()` 和异步 `renderStream()` 两套实现。
 *
 * 代码生成策略尽量保持“结构递归”：
 * 每一种 IR 节点各自负责生成一段表达式，再由父节点把子表达式拼起来。
 * 这样后续扩展新节点类型时，只需要补对应分支，不必重写整套渲染器。
 *
 * 这里最终不会真的“执行”渲染，而是生成一段类方法源码字符串：
 * - `render()` 负责同步 SSR，适合没有异步依赖的场景；
 * - `renderStream()` 负责流式 SSR，允许表达式值、Teleport、Suspense 等能力
 *   在运行时继续异步展开。
 *
 * 可以把这个文件理解为“SSR 渲染器的源码模板机”：
 * IR 是输入，类方法字符串是输出，而真正的 HTML 拼接行为发生在生成后的代码里。
 */

export interface SSRCodegenResult {
  // 同步 SSR 方法源码，例如 `static render(...) { ... }`
  method: string;
  // 流式 SSR 方法源码，例如 `static async *renderStream(...) { ... }`
  streamMethod: string;
  // 便于上游直接内联的完整代码片段，通常等于两段方法源码的拼接。
  code: string;
}

// 生成类方法源码时需要控制缩进，避免最终输出的代码可读性太差。
const indent = (source: string, level = 1): string => {
  const prefix = '  '.repeat(level);

  return source
    .split('\n')
    .map((line) => (line.length > 0 ? `${prefix}${line}` : line))
    .join('\n');
};

// 所有静态 HTML 片段都走 JSON.stringify，避免手写转义逻辑。
const quote = (value: string): string => JSON.stringify(value);

// SSR 表达式求值统一委托给 runtime helper，编译器只负责把表达式源码和上下文串起来。
const evaluateExpression = (expression: string, contextVar = 'ctx'): string => {
  return `ssrEvaluate(${quote(expression)}, ${contextVar})`;
};

/**
 * island 的组件表达式在模块作用域里可见（例如同文件声明的 `Child`）。
 *
 * 这类标识符必须直接引用；走 `ssrEvaluate`（`with (ctx)`）会拿不到模块绑定。
 * `this.xxx` 形式仍然交给 SSR 上下文求值。
 */
const evaluateIslandComponent = (
  expression: string,
  contextVar = 'ctx'
): string => {
  const trimmed = expression.trim();

  if (/^[A-Za-z_$][\w$]*$/.test(trimmed)) {
    return trimmed;
  }

  return evaluateExpression(trimmed, contextVar);
};

// SSR 布尔属性遵循 HTML 语义：为 true 时只输出属性名，不附带字符串值。
const renderStaticAttribute = (name: string, value: string | true): string => {
  if (value === true) {
    return ` ${name}`;
  }

  return ` ${name}="${value}"`;
};

// 动态属性统一交给 runtime 做序列化，避免这里重复处理 null/false/数组等值类型。
const renderDynamicAttribute = (attribute: DynamicAttributeIR): string => {
  return `ssrSerializeAttribute(${quote(attribute.name)}, ${evaluateExpression(attribute.expression)})`;
};

const renderElementOpen = (node: ElementIR): string => {
  // `class` / `style` 允许同时出现静态值和动态值，因此需要单独拆开处理。
  const dynamicClassAttribute = node.dynamicAttributes.find(
    (attribute) => attribute.name === 'class'
  );
  const dynamicStyleAttribute = node.dynamicAttributes.find(
    (attribute) => attribute.name === 'style'
  );
  const staticClassValue =
    typeof node.staticAttributes.class === 'string'
      ? node.staticAttributes.class
      : '';
  const staticStyleValue =
    typeof node.staticAttributes.style === 'string'
      ? node.staticAttributes.style
      : '';
  const staticAttributeEntries = Object.entries(node.staticAttributes).filter(
    ([name]) =>
      !(
        (name === 'class' && dynamicClassAttribute) ||
        (name === 'style' && dynamicStyleAttribute)
      )
  );
  const parts = [
    // 静态属性先内联进起始标签，动态 class/style 再单独通过 helper 合并，
    // 避免静态值和运行时值互相覆盖。
    quote(
      `<${node.tagName}${staticAttributeEntries
        .map(([name, value]) => renderStaticAttribute(name, value))
        .join('')}`
    ),
    dynamicClassAttribute
      ? `ssrSerializeAttribute("class", [${quote(staticClassValue)}, ${evaluateExpression(
          dynamicClassAttribute.expression
        )}])`
      : null,
    dynamicStyleAttribute
      ? `ssrSerializeAttribute("style", [${quote(staticStyleValue)}, ${evaluateExpression(
          dynamicStyleAttribute.expression
        )}])`
      : null,
    ...node.dynamicAttributes
      .filter(
        (attribute) => attribute.name !== 'class' && attribute.name !== 'style'
      )
      .map((attribute) => renderDynamicAttribute(attribute)),
    // 起始标签的 `>` 也按字面量参与拼接，保证 open tag 整体是连续表达式。
    quote('>'),
  ].filter((part): part is string => part !== null);

  return parts.join(' + ');
};

// 闭合标签没有动态性，直接返回字符串字面量即可。
const renderElementClose = (node: ElementIR): string => {
  return quote(`</${node.tagName}>`);
};

// `html={expr}` 会完全接管子节点渲染，因此这里先提取出来供后续分支判断。
const getHtmlDirectiveExpression = (node: ElementIR): string | null => {
  const directive = node.directives.find(
    (candidate) => candidate.kind === 'html'
  );
  return directive?.expression ?? null;
};

// Boundary/Transition 的 payload 本质上也是表达式，只是语义上交给不同 helper 消费。
const renderBoundaryPayload = (
  node: BoundaryIR,
  contextVar: string
): string => {
  return evaluateExpression(node.payloadExpression, contextVar);
};

const renderTransitionPayload = (
  node: TransitionIR,
  contextVar: string
): string => {
  return evaluateExpression(node.payloadExpression, contextVar);
};

// 同步 SSR 的单节点生成器。每个分支都返回“一段 JS 表达式源码”，而不是直接返回 HTML。
const renderTemplateNode = (
  node: TemplateIRNode,
  contextVar: string
): string => {
  switch (node.type) {
    case 'TextIR':
      // 纯文本在 SSR 中最简单，直接作为字面量拼进输出。
      return quote(node.value);
    case 'ExpressionIR':
      // 文本插值仍交给 runtime helper，统一处理转义与空值归一。
      return `ssrRenderTextSlot(${node.slotIndex}, ${evaluateExpression(node.expression, contextVar)})`;
    case 'ListIR':
      // 列表 slot 只负责把 iterable 与 fallback 交给 runtime helper，具体展开交由运行时完成。
      return `ssrRenderForSlot(${node.slotIndex}, ${evaluateExpression(node.expression, contextVar)}, ${quote(
        node.fallbackTemplateHtml ?? ''
      )})`;
    case 'IfIR':
      // `IfIR` 在 SSR 阶段不再逐子节点解释，而是直接在静态模板和 fallback 模板之间二选一。
      return `ssrRenderBlockSlot(${node.slotIndex}, ${evaluateExpression(node.expression, contextVar)} ? ${quote(
        node.templateHtml
      )} : ${quote(node.fallbackTemplateHtml ?? '')}, "if", { strategy: "static-template" })`;
    case 'DynamicIR':
      if (node.island) {
        // island：由子组件自己输出 SSR 内容，并带上水合优先级与可序列化 props。
        return `ssrRenderIslandSlot(${node.slotIndex}, ${evaluateIslandComponent(
          node.componentExpression,
          contextVar
        )}, ${evaluateExpression(node.propsExpression, contextVar)}, ${quote(
          node.island.priority
        )}, ${quote(node.templateHtml)})`;
      }
      if (
        node.enhancedComponentName &&
        isTransitionPayloadComponentName(node.enhancedComponentName) &&
        doesTransitionPayloadComponentUseSsrWrapperTag(
          node.enhancedComponentName
        )
      ) {
        const childExpression = renderTemplateNodes(
          node.children ?? [],
          contextVar
        );
        if (!node.ssrWrapperTagExpression) {
          return `ssrRenderBlockSlot(${node.slotIndex}, ${childExpression}, "dynamic")`;
        }
        // 某些增强组件要求 SSR 阶段补一个包装标签，标签名仍然来自动态表达式。
        return `ssrRenderBlockSlot(${node.slotIndex}, (() => { const __lania_tag = ssrEvaluate(${quote(
          node.ssrWrapperTagExpression
        )}, ${contextVar}); const __lania_wrapper = typeof __lania_tag === "string" && __lania_tag.length > 0 ? __lania_tag : "span"; return "<" + __lania_wrapper + ">" + ${childExpression} + "</" + __lania_wrapper + ">"; })(), "dynamic")`;
      }
      // 一般动态块直接复用编译期缓存好的模板 HTML，运行时只标记这是一个 dynamic block。
      return `ssrRenderBlockSlot(${node.slotIndex}, ${quote(node.templateHtml)}, "dynamic")`;
    case 'KeepAliveIR': {
      // KeepAlive 的 SSR 只需要把子树内容包成对应 block，真正缓存策略由运行时决定。
      const childExpression = renderTemplateNodes(
        node.children ?? [],
        contextVar
      );
      return `ssrRenderBlockSlot(${node.slotIndex}, ${childExpression}, "keepalive")`;
    }
    case 'TeleportIR':
      // Teleport 在 SSR 中除了输出占位/内容，还要把目标位置信息交给 runtime 管理。
      return `ssrRenderTeleportSlot(${node.slotIndex}, ${evaluateExpression(
        node.targetExpression,
        contextVar
      )}, ${quote(node.templateHtml)}, ${contextVar})`;
    case 'BoundaryIR': {
      const childExpression = renderTemplateNodes(node.children, contextVar);

      if (isSuspenseBoundaryComponentName(node.componentName)) {
        // Suspense 需要显式走边界渲染，保留 fallback 与 chunk drain 能力。
        return `ssrRenderSuspenseBoundary(${node.boundaryIndex}, () => ${childExpression}, ${quote(
          node.fallbackTemplateHtml ?? ''
        )}, ${contextVar}, ${renderBoundaryPayload(node, contextVar)})`;
      }

      // 非 Suspense 边界走统一增强边界 helper，边界 id 使用前缀区分语义类型。
      return `ssrRenderEnhancedBoundary(${quote(`b${node.boundaryIndex}`)}, ${quote(
        node.componentName
      )}, ${childExpression}, ${renderBoundaryPayload(node, contextVar)})`;
    }
    case 'TransitionIR': {
      const childExpression = renderTemplateNodes(node.children, contextVar);
      // Transition SSR 复用增强边界 helper，但 id 前缀改为 `t`，与普通 boundary 区分。
      return `ssrRenderEnhancedBoundary(${quote(`t${node.transitionIndex}`)}, ${quote(
        node.componentName
      )}, ${childExpression}, ${renderTransitionPayload(node, contextVar)})`;
    }
    case 'ElementIR': {
      const childExpression = getHtmlDirectiveExpression(node)
        ? // `html` 指令会覆盖常规 children，直接把表达式结果原样注入为 innerHTML。
          `ssrRenderHtmlSlot(-1, ${evaluateExpression(getHtmlDirectiveExpression(node)!, contextVar)})`
        : renderTemplateNodes(node.children, contextVar);

      // 普通元素最终总是落成：开标签 + 子内容 + 闭标签。
      return [
        renderElementOpen(node),
        childExpression,
        renderElementClose(node),
      ].join(' + ');
    }
    default:
      // 未识别节点在 SSR 中安全退化为空串，避免生成无效源码。
      return quote('');
  }
};

// 同步版本的多节点拼接器，职责只是把单节点生成结果按顺序串起来。
const renderTemplateNodes = (
  nodes: readonly TemplateIRNode[],
  contextVar: string
): string => {
  if (nodes.length === 0) {
    return quote('');
  }

  return nodes.map((node) => renderTemplateNode(node, contextVar)).join(' + ');
};

// 异步/流式 SSR 的单节点生成器。整体结构和同步版保持一致，只在“取值”环节补 `await`。
const renderTemplateNodeAsync = (
  node: TemplateIRNode,
  contextVar: string
): string => {
  switch (node.type) {
    case 'TextIR':
      return quote(node.value);
    case 'ExpressionIR':
      // 流式渲染会在输出前先 resolve Promise/thenable。
      return `ssrRenderTextSlot(${node.slotIndex}, await ssrResolveValue(${evaluateExpression(
        node.expression,
        contextVar
      )}))`;
    case 'ListIR':
      // 列表表达式可能返回 Promise，因此流式版本在传给 helper 前先 resolve。
      return `ssrRenderForSlot(${node.slotIndex}, await ssrResolveValue(${evaluateExpression(
        node.expression,
        contextVar
      )}), ${quote(node.fallbackTemplateHtml ?? '')})`;
    case 'IfIR':
      // 条件本身也可能异步，因此异步版的 if 判断需要先拿到 resolved value。
      return `ssrRenderBlockSlot(${node.slotIndex}, (await ssrResolveValue(${evaluateExpression(
        node.expression,
        contextVar
      )})) ? ${quote(node.templateHtml)} : ${quote(node.fallbackTemplateHtml ?? '')}, "if", { strategy: "static-template" })`;
    case 'DynamicIR':
      if (node.island) {
        return `ssrRenderIslandSlot(${node.slotIndex}, await ssrResolveValue(${evaluateIslandComponent(
          node.componentExpression,
          contextVar
        )}), await ssrResolveValue(${evaluateExpression(
          node.propsExpression,
          contextVar
        )}), ${quote(node.island.priority)}, ${quote(node.templateHtml)})`;
      }
      if (
        node.enhancedComponentName &&
        isTransitionPayloadComponentName(node.enhancedComponentName) &&
        doesTransitionPayloadComponentUseSsrWrapperTag(
          node.enhancedComponentName
        )
      ) {
        const childExpression = renderTemplateNodesAsync(
          node.children ?? [],
          contextVar
        );
        if (!node.ssrWrapperTagExpression) {
          return `ssrRenderBlockSlot(${node.slotIndex}, ${childExpression}, "dynamic")`;
        }
        // 异步版本和同步版本保持同一结构，只是在取值前多一步 `ssrResolveValue`。
        return `ssrRenderBlockSlot(${node.slotIndex}, await (async () => { const __lania_tag = await ssrResolveValue(ssrEvaluate(${quote(
          node.ssrWrapperTagExpression
        )}, ${contextVar})); const __lania_wrapper = typeof __lania_tag === "string" && __lania_tag.length > 0 ? __lania_tag : "span"; return "<" + __lania_wrapper + ">" + ${childExpression} + "</" + __lania_wrapper + ">"; })(), "dynamic")`;
      }
      return `ssrRenderBlockSlot(${node.slotIndex}, ${quote(node.templateHtml)}, "dynamic")`;
    case 'KeepAliveIR': {
      const childExpression = renderTemplateNodesAsync(
        node.children ?? [],
        contextVar
      );
      return `ssrRenderBlockSlot(${node.slotIndex}, ${childExpression}, "keepalive")`;
    }
    case 'TeleportIR':
      // Teleport 目标也可能来自异步表达式，所以流式版本同样要先 resolve target。
      return `ssrRenderTeleportSlot(${node.slotIndex}, await ssrResolveValue(${evaluateExpression(
        node.targetExpression,
        contextVar
      )}), ${quote(node.templateHtml)}, ${contextVar})`;
    case 'BoundaryIR': {
      const childExpression = renderTemplateNodesAsync(
        node.children,
        contextVar
      );

      if (isSuspenseBoundaryComponentName(node.componentName)) {
        // Suspense 的子树本来就允许异步，因此这里直接传 async thunk 给 runtime。
        return `ssrRenderSuspenseBoundary(${node.boundaryIndex}, async () => ${childExpression}, ${quote(
          node.fallbackTemplateHtml ?? ''
        )}, ${contextVar}, ${renderBoundaryPayload(node, contextVar)})`;
      }

      return `ssrRenderEnhancedBoundary(${quote(`b${node.boundaryIndex}`)}, ${quote(
        node.componentName
      )}, ${childExpression}, ${renderBoundaryPayload(node, contextVar)})`;
    }
    case 'TransitionIR': {
      const childExpression = renderTemplateNodesAsync(
        node.children,
        contextVar
      );
      return `ssrRenderEnhancedBoundary(${quote(`t${node.transitionIndex}`)}, ${quote(
        node.componentName
      )}, ${childExpression}, ${renderTransitionPayload(node, contextVar)})`;
    }
    case 'ElementIR': {
      const childExpression = getHtmlDirectiveExpression(node)
        ? `ssrRenderHtmlSlot(-1, await ssrResolveValue(${evaluateExpression(getHtmlDirectiveExpression(node)!, contextVar)}))`
        : renderTemplateNodesAsync(node.children, contextVar);

      return [
        renderElementOpen(node),
        childExpression,
        renderElementClose(node),
      ].join(' + ');
    }
    default:
      return quote('');
  }
};

// 异步版本的多节点拼接器；节点顺序仍保持模板原顺序，不做并发重排。
const renderTemplateNodesAsync = (
  nodes: readonly TemplateIRNode[],
  contextVar: string
): string => {
  if (nodes.length === 0) {
    return quote('');
  }

  return nodes
    .map((node) => renderTemplateNodeAsync(node, contextVar))
    .join(' + ');
};

// 收集 SSR 表达式执行上下文中还需要额外挂进去的名称。
// 这些名称通常来自列表/条件等阶段 hoist 出去的模板 helper，如果不并入 ctx，
// 运行时 `ssrEvaluate()` 在求值表达式时就拿不到它们。
const collectSSRExpressionScopeNames = (
  nodes: readonly TemplateIRNode[]
): string[] => {
  const names = new Set<string>();
  const visit = (node: TemplateIRNode): void => {
    switch (node.type) {
      case 'ListIR': {
        const listNode = node as ListIR;
        // 列表模板可能拆成普通 item / keyed item 两类 helper，这里都要收集。
        if (listNode.itemTemplateHoistName) {
          names.add(listNode.itemTemplateHoistName);
        }
        if (listNode.keyedItemHoistName) {
          names.add(listNode.keyedItemHoistName);
        }
        return;
      }
      case 'KeepAliveIR':
      case 'BoundaryIR':
      case 'TransitionIR':
      case 'ElementIR':
      case 'DynamicIR':
      case 'IfIR':
        // 这些节点都可能继续嵌套子树，因此递归向下收集。
        node.children?.forEach(visit);
        if (node.type === 'IfIR') {
          // `IfIR` 额外还有 fallback 分支，需要一起扫描。
          node.fallbackChildren?.forEach(visit);
        }
        return;
      default:
        return;
    }
  };

  nodes.forEach(visit);
  return [...names];
};

export const generateSSRCode = (component: ComponentIR): SSRCodegenResult => {
  // 先计算表达式求值所需的额外作用域名称，再统一构造上下文变量。
  const expressionScopeNames = collectSSRExpressionScopeNames(
    component.template.roots
  );
  const contextVar = '__lania_ssr_ctx';
  const contextInitializer =
    expressionScopeNames.length > 0
      ? // hoist 出来的模板 helper 名称也要并入上下文，确保表达式求值时可见。
        `const ${contextVar} = { ...ctx, ${expressionScopeNames.join(', ')} };`
      : `const ${contextVar} = ctx;`;
  // 同步 render 与异步 renderStream 共用同一棵模板 IR，只是生成器不同。
  const returnExpression = renderTemplateNodes(
    component.template.roots,
    contextVar
  );
  const streamReturnExpression = renderTemplateNodesAsync(
    component.template.roots,
    contextVar
  );
  const method = [
    'static render(ctx: Record<string, unknown> = {}): string {',
    indent(contextInitializer),
    indent(`return ${returnExpression};`),
    '}',
  ].join('\n');
  const streamMethod = [
    'static async *renderStream(ctx: Record<string, unknown> = {}): AsyncGenerator<string, void, void> {',
    indent(contextInitializer),
    // 先产出当前组件主体，再把 Suspense 累积的异步 chunk 逐个 drain 出去。
    indent(`yield ${streamReturnExpression};`),
    indent('for (const chunk of await ssrDrainSuspenseChunks(ctx)) {'),
    indent('yield chunk;', 2),
    indent('}'),
    '}',
  ].join('\n');

  return {
    method,
    streamMethod,
    code: [method, '', streamMethod].join('\n'),
  };
};
