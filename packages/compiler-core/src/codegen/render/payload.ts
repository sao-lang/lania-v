import type { TemplateIRNode } from '../../ir/component';

/**
 * 子树 payload 辅助生成。
 *
 * 当 `If` / `Dynamic` / `Boundary` / `Teleport` / `KeepAlive` 这类 block slot
 * 在运行时需要“延迟接管自己的子树”时，编译器不能只把一段静态 HTML 交给它，
 * 还需要额外告诉运行时：
 * 1. 这棵子树里有哪些 hoisted 模板需要预先声明；
 * 2. 这棵子树依赖哪些 signal/store 键；
 * 3. 这棵子树里每个可交互节点在什么路径、应该怎样重新求值。
 *
 * 本文件就是把这些“子树元信息”从模板 IR 中提炼出来，供 render codegen 复用。
 *
 * 可以把它理解成 block payload 的“编译期打包器”：
 * - 输入是模板 IR 子树；
 * - 输出是 hoist 声明、依赖键集合，以及可直接拼进生成代码的 binding 描述源码。
 *
 * 这里不会真正执行任何子树渲染逻辑，而是提前把运行时需要恢复的信息序列化出来，
 * 以便 `generate.ts` 在生成 `_renderAndMount()` 时，把这些 payload 一起塞进对应 block slot。
 */

export const collectChildPayloadHoists = (
  nodes: readonly TemplateIRNode[],
  seen = new Set<string>()
): string[] => {
  const hoists: string[] = [];
  const pushTemplateHoist = (name: string | undefined, html: string | undefined): void => {
    if (!name || typeof html !== 'string' || seen.has(name)) {
      return;
    }
    seen.add(name);
    // payload 子树引用到的静态模板也必须在组件类作用域中 hoist，否则运行时拿不到。
    hoists.push(`const ${name} = createStaticTemplate(${JSON.stringify(html)});`);
  };

  nodes.forEach((node) => {
    switch (node.type) {
      case 'IfIR':
        // 条件块可能同时持有 truthy / falsy 两套模板，因此两边都要收集。
        pushTemplateHoist(node.hoistName, node.templateHtml);
        pushTemplateHoist(node.fallbackHoistName, node.fallbackTemplateHtml);
        hoists.push(...collectChildPayloadHoists(node.children ?? [], seen));
        hoists.push(...collectChildPayloadHoists(node.fallbackChildren ?? [], seen));
        return;
      case 'ListIR':
        // 列表块的 item / keyed item / fallback 模板都可能在运行时被单独引用。
        pushTemplateHoist(node.itemTemplateHoistName, node.itemTemplateHtml);
        pushTemplateHoist(node.keyedItemHoistName, node.keyedItemTemplateHtml);
        pushTemplateHoist(node.fallbackHoistName, node.fallbackTemplateHtml);
        return;
      case 'DynamicIR':
        pushTemplateHoist(node.hoistName, node.templateHtml);
        hoists.push(...collectChildPayloadHoists(node.children ?? [], seen));
        return;
      case 'BoundaryIR':
      case 'TransitionIR':
        pushTemplateHoist(node.hoistName, node.templateHtml);
        pushTemplateHoist(node.fallbackHoistName, node.fallbackTemplateHtml);
        hoists.push(...collectChildPayloadHoists(node.children ?? [], seen));
        return;
      case 'TeleportIR':
        pushTemplateHoist(node.hoistName, node.templateHtml);
        hoists.push(...collectChildPayloadHoists(node.children ?? [], seen));
        return;
      case 'KeepAliveIR':
        pushTemplateHoist(node.hoistName, node.templateHtml);
        hoists.push(...collectChildPayloadHoists(node.children ?? [], seen));
        return;
      case 'ElementIR':
        // 普通元素自己不产生 block payload，但其内部子节点仍可能继续产生。
        hoists.push(...collectChildPayloadHoists(node.children, seen));
        return;
      default:
        return;
    }
  });

  return hoists;
};

export const collectChildPayloadDependencyKeys = (
  nodes: readonly TemplateIRNode[],
  signalBindingMap: Readonly<Record<string, string>>
): string[] => {
  const keys = new Set<string>();
  const tryCollect = (expression: string | undefined): void => {
    if (!expression) {
      return;
    }
    // 这里先用“字符串包含”做保守收集，目标是尽量别漏依赖，而不是做精确语义分析。
    Object.keys(signalBindingMap).forEach((key) => {
      if (expression.includes(key)) {
        keys.add(key);
      }
    });
  };

  nodes.forEach((node) => {
    switch (node.type) {
      case 'ExpressionIR':
        // 纯文本插值的依赖最直接，检查表达式本身即可。
        tryCollect(node.expression);
        return;
      case 'IfIR':
        // 条件表达式和两个分支内部都可能继续访问响应式值。
        tryCollect(node.expression);
        collectChildPayloadDependencyKeys(node.children ?? [], signalBindingMap).forEach((key) =>
          keys.add(key)
        );
        collectChildPayloadDependencyKeys(node.fallbackChildren ?? [], signalBindingMap).forEach((key) =>
          keys.add(key)
        );
        return;
      case 'ListIR':
        // 列表块对子项模板的依赖不在这里展开；这里只关心 iterable 表达式本身。
        tryCollect(node.expression);
        return;
      case 'DynamicIR':
        tryCollect(node.componentExpression);
        tryCollect(node.propsExpression);
        collectChildPayloadDependencyKeys(node.children ?? [], signalBindingMap).forEach((key) =>
          keys.add(key)
        );
        return;
      case 'BoundaryIR':
      case 'TransitionIR':
        tryCollect(node.payloadExpression);
        collectChildPayloadDependencyKeys(node.children ?? [], signalBindingMap).forEach((key) =>
          keys.add(key)
        );
        return;
      case 'TeleportIR':
        tryCollect(node.targetExpression);
        collectChildPayloadDependencyKeys(node.children ?? [], signalBindingMap).forEach((key) =>
          keys.add(key)
        );
        return;
      case 'KeepAliveIR':
        tryCollect(node.payloadExpression);
        collectChildPayloadDependencyKeys(node.children ?? [], signalBindingMap).forEach((key) =>
          keys.add(key)
        );
        return;
      case 'ElementIR':
        // 普通元素自己没有 block payload，但其内部动态子节点仍可能继续引用依赖。
        collectChildPayloadDependencyKeys(node.children, signalBindingMap).forEach((key) => keys.add(key));
        return;
      default:
        return;
    }
  });

  return [...keys];
};

// 把模板子树转换为一组“可序列化的绑定描述对象源码”，供 block payload 在运行时延迟回放。
export const renderChildPayloadBindings = (nodes: readonly TemplateIRNode[]): string[] => {
  return nodes.flatMap((node) => {
    switch (node.type) {
      case 'ExpressionIR':
        return [
          // 文本绑定只需要路径、slotIndex 和求值表达式即可在子树接管时重放。
          `{ kind: "text", slotIndex: ${node.slotIndex}, path: [${node.path.join(', ')}], evaluate: () => (${node.expression}) }`,
        ];
      case 'ElementIR':
        return [
          // 元素上的动态属性、事件、指令会被拆成多条独立描述，运行时按 kind 分发。
          ...node.dynamicAttributes.map(
            (attribute) =>
              `{ kind: "attr", slotIndex: -1, path: [${attribute.path.join(', ')}], name: ${JSON.stringify(attribute.name)}, evaluate: () => (${attribute.expression}) }`
          ),
          ...node.events.map(
            (event) =>
              `{ kind: "event", slotIndex: -1, path: [${event.path.join(', ')}], name: ${JSON.stringify(event.name)}, modifiers: ${JSON.stringify(event.modifiers)}${event.listener ? `, listener: ${JSON.stringify(event.listener)}` : ''}, evaluate: () => (${event.expression}) }`
          ),
          ...node.directives.flatMap((directive) => {
            if (directive.kind === 'bind') {
              return [
                `{ kind: "prop", slotIndex: -1, path: [${directive.path.join(', ')}], name: ${JSON.stringify(directive.name)}, evaluate: () => (${directive.expression}) }`,
              ];
            }

            if (directive.kind === 'class') {
              return [
                `{ kind: "class", slotIndex: -1, path: [${directive.path.join(', ')}], name: ${JSON.stringify(directive.name)}, evaluate: () => (${directive.expression}) }`,
              ];
            }

            if (directive.kind === 'style') {
              return [
                `{ kind: "style", slotIndex: -1, path: [${directive.path.join(', ')}], name: ${JSON.stringify(directive.name)}, unit: ${directive.unit ? JSON.stringify(directive.unit) : 'undefined'}, evaluate: () => (${directive.expression}) }`,
              ];
            }

            if (directive.kind === 'ref') {
              return [
                `{ kind: "ref", slotIndex: -1, path: [${directive.path.join(', ')}], evaluate: () => (${directive.expression}) }`,
              ];
            }

            return [
              `{ kind: "directive", slotIndex: -1, path: [${directive.path.join(', ')}], name: ${JSON.stringify(directive.name)}, directiveKind: ${JSON.stringify(directive.kind)}, modifiers: ${JSON.stringify(directive.modifiers)}, unit: ${directive.unit ? JSON.stringify(directive.unit) : 'undefined'}, evaluate: () => (${directive.expression}) }`,
            ];
          }),
          // 元素本身只是容器，真正的后代 payload 继续递归展开。
          ...renderChildPayloadBindings(node.children),
        ];
      case 'BoundaryIR':
      case 'TransitionIR':
        return [
          // Boundary/Transition 在子树 payload 里统一按 boundary block 语义回放。
          `{ kind: "boundary", slotIndex: ${node.slotIndex}, path: [${node.path.join(', ')}], template: ${node.hoistName}, fallbackTemplate: ${node.fallbackHoistName ?? 'undefined'}, evaluate: () => ({ __lania_boundary: "block", payload: ${node.payloadExpression}, bindings: [${renderChildPayloadBindings(node.children ?? []).join(', ')}] }) }`,
        ];
      case 'IfIR':
        return [
          // 条件块 payload 会把主条件与两套子绑定一并打包，便于运行时按分支延迟接管。
          `{ kind: "if", slotIndex: ${node.slotIndex}, path: [${node.path.join(', ')}], template: ${node.hoistName}, fallbackTemplate: ${node.fallbackHoistName ?? 'undefined'}, evaluate: () => ({ __lania_if: "block", when: ${node.expression}, mode: ${node.mode ? JSON.stringify(node.mode) : 'undefined'}, truthyBindings: [${renderChildPayloadBindings(node.children ?? []).join(', ')}], falsyBindings: [${renderChildPayloadBindings(node.fallbackChildren ?? []).join(', ')}] }) }`,
        ];
      case 'ListIR':
        return [
          // `for` payload 只回传列表值本身，item 模板/hoist 已在别处提前准备好。
          `{ kind: "for", slotIndex: ${node.slotIndex}, path: [${node.path.join(', ')}], fallbackTemplate: ${node.fallbackHoistName ?? 'undefined'}, evaluate: () => (${node.expression}) }`,
        ];
      case 'DynamicIR':
        return [
          // Dynamic block 必须把 component、props 和 childBindings 成组返回，运行时才能完整重建。
          `{ kind: "dynamic", slotIndex: ${node.slotIndex}, path: [${node.path.join(', ')}], template: ${node.hoistName}, evaluate: () => ({ __lania_dynamic: "block", component: ${node.componentExpression}, props: ${node.propsExpression}, childBindings: [${renderChildPayloadBindings(node.children ?? []).join(', ')}] }) }`,
        ];
      case 'TeleportIR':
        return [
          // Teleport 的目标容器是运行时决定的，所以 payload 必须保留 target 求值逻辑。
          `{ kind: "teleport", slotIndex: ${node.slotIndex}, path: [${node.path.join(', ')}], template: ${node.hoistName}, evaluate: () => ({ __lania_teleport: "block", target: ${node.targetExpression}, bindings: [${renderChildPayloadBindings(node.children ?? []).join(', ')}] }) }`,
        ];
      case 'KeepAliveIR':
        return [
          // KeepAlive payload 除了 block 元信息，还会把 metadata 一并并入，供运行时恢复缓存语义。
          `{ kind: "keepalive", slotIndex: ${node.slotIndex}, path: [${node.path.join(', ')}], template: ${node.hoistName}, evaluate: () => { const payload = ${node.payloadExpression}; return { __lania_keepalive: "block", payload, ...(payload.metadata ?? {}), bindings: [${renderChildPayloadBindings(node.children ?? []).join(', ')}] }; } }`,
        ];
      default:
        return [];
    }
  });
};
