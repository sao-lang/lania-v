import type {
  AttributeNode,
  ElementNode,
  ExpressionNode,
  TemplateChildNode,
} from '../../../ast';
import { compileKeyedEachItemTemplate } from '../helpers/keyed-each';
import type { IfIR, ListIR, TemplateLowerer } from '../types';
import {
  getAttributeExpression,
  resolveWhenBranches,
  renderStaticTemplateFromExpression,
} from '../helpers/template-helpers';

/**
 * 条件与列表控制流 lowering。
 *
 * 这个模块负责把模板里的 `When` / `Switch` / `Each` 等高层控制流节点，
 * 下降为组件模板 IR 中更接近运行时消费形态的 `IfIR` 与 `ListIR`。
 *
 * 它的核心思路是：
 * - 先从模板节点中提取结构化语义，例如条件表达式、fallback、key、mode；
 * - 再把这些高层语法改写成统一 IR，方便后续 slot 分配、render codegen、SSR codegen 复用；
 * - 对 `Switch` 这类语法糖，先重写成嵌套 `When`，避免后续阶段维护额外分支类型。
 *
 * 这里尽量在 lowering 阶段就把静态模板 HTML、hoist 名称和辅助元信息准备好，
 * 这样后续阶段可以更偏向“消费结果”，而不是重新解析模板语义。
 *
 * 从职责上看，它位于“模板语法”与“列表/条件运行时协议”之间：
 * - 输入还是 `ElementNode` 级别的控制流标签；
 * - 输出已经是可以被 codegen 直接消费的 `IfIR` / `ListIR`；
 * - 因而这里既要保留源码意图，也要尽量提前补齐运行时需要的模板合同字段。
 */
const hashTemplateHtml = (html: string): string => {
  let hash = 5381;
  for (let i = 0; i < html.length; i += 1) {
    hash = ((hash << 5) + hash) ^ html.charCodeAt(i);
  }
  return (hash >>> 0).toString(16);
};

// hoist 名称：slotIndex 在全组件范围内唯一，用它做主键即可避免嵌套块重名；
// path 只作为可读性后缀保留（可能重复，不参与唯一性）。
const templateNamePrefix = (
  path: number[],
  slotIndex: number,
  templateHash: string
): string =>
  `__when_slot_${slotIndex}_${path.join('_') || 'root'}_${templateHash}`;

const normalizeStaticMode = (
  expression: string | null
): 'retain' | 'remount' | undefined => {
  // 只接受编译期就能确定的字面量模式，其他表达式一律回退为未指定。
  return expression === '"retain"' || expression === '"remount"'
    ? (expression.slice(1, -1) as 'retain' | 'remount')
    : undefined;
};

const createExpressionAttribute = (
  name: string,
  expression: string
): AttributeNode => {
  // `Switch` 转 `When` 时需要动态构造属性节点，因此这里提供一个小型 AST 工厂。
  const value: ExpressionNode = {
    type: 'ExpressionNode',
    expression,
  };
  return {
    type: 'AttributeNode',
    name,
    value,
    static: false,
  };
};

const createStaticAttribute = (name: string, value: string): AttributeNode => {
  return {
    type: 'AttributeNode',
    name,
    value,
    static: true,
  };
};

const createElementNode = (
  tagName: string,
  children: TemplateChildNode[] = [],
  attributes: AttributeNode[] = []
): ElementNode => {
  return {
    type: 'ElementNode',
    tagName,
    attributes,
    events: [],
    directives: [],
    children,
    selfClosing: false,
  };
};

export const lowerWhenElement = (
  child: ElementNode,
  path: number[],
  slotIndex: number,
  lowerTemplateChildren: TemplateLowerer
): IfIR | null => {
  const whenExpression = getAttributeExpression(child, 'value');

  if (!whenExpression) {
    return null;
  }

  const branches = resolveWhenBranches(child);
  // truthy / fallback 分支都继续递归 lowering，但在这里保留增强组件的动态包裹语义。
  //
  // 分支内部的 slot 编号必须接在外层 `When` 自己的 slotIndex 之后：分支模板会和
  // `When` 生成的 IfSlot 一起进入同一份线性 slot 表，如果都从 0 开始就会撞号，
  // 嵌套 `<When>` / `Each` 的 slot 会被外层的覆盖而永远不被注册。
  const truthyTemplate = lowerTemplateChildren(
    branches.truthyChildren,
    [],
    slotIndex + 1,
    0,
    0,
    { preserveChildrenOnlyEnhancedAsDynamic: true }
  );
  const fallbackTemplate =
    branches.fallbackChildren.length > 0
      ? lowerTemplateChildren(
          branches.fallbackChildren,
          [],
          slotIndex + 1 + truthyTemplate.nextSlotIndex - (slotIndex + 1),
          0,
          0,
          { preserveChildrenOnlyEnhancedAsDynamic: true }
        )
      : null;
  const fallbackExpression = getAttributeExpression(child, 'fallback');
  const modeExpression = getAttributeExpression(child, 'mode');
  // fallback 既可能来自显式 `<Else>` 子树，也可能来自 `fallback={...}` 表达式属性。
  const fallbackTemplateHtml =
    fallbackTemplate?.staticHtml ||
    (fallbackExpression
      ? (renderStaticTemplateFromExpression(fallbackExpression) ?? undefined)
      : undefined);
  const mode = normalizeStaticMode(modeExpression);
  // hoist 名称带上 path + slot + html hash，尽量保持稳定且可避免冲突。
  //
  // 嵌套在别的 block 里的 `When`，其 path 是相对当前 block 内部模板的局部坐标，
  // 不同分支可能出现相同的 `path + slotIndex`。这里额外并入 HTML hash，
  // 并在 hash 冲突时再退让到父路径，保证同一模块内不会出现重复声明。
  const templateHash = hashTemplateHtml(truthyTemplate.staticHtml);
  const fallbackHash = fallbackTemplateHtml
    ? hashTemplateHtml(fallbackTemplateHtml)
    : null;
  const namePrefix = templateNamePrefix(path, slotIndex, templateHash);

  return {
    type: 'IfIR',
    path,
    slotIndex,
    expression: whenExpression,
    mode,
    templateHtml: truthyTemplate.staticHtml,
    hoistName: namePrefix,
    children: truthyTemplate.nodes,
    fallbackTemplateHtml,
    fallbackChildren: fallbackTemplate?.nodes,
    fallbackHoistName: fallbackTemplateHtml
      ? `__when_fallback_slot_${slotIndex}_${path.join('_') || 'root'}_${fallbackHash ?? ''}`
      : undefined,
  };
};

export const lowerSwitchElement = (
  child: ElementNode,
  path: number[],
  slotIndex: number,
  lowerTemplateChildren: TemplateLowerer
): IfIR | null => {
  const mode = normalizeStaticMode(getAttributeExpression(child, 'mode'));
  // `Switch` 有两种形态：带 `value` 时 `<Case when>` 表示取值匹配；
  // 不带 `value` 时 `<Case when>` / `<Match value>` 表示布尔分支。
  const switchValueExpression = getAttributeExpression(child, 'value');

  // `Switch` 只消费直接子级里的 `Case` / `Match` / `Default`，其他节点在这里被忽略。
  const elementChildren = child.children.filter(
    (candidate): candidate is ElementNode =>
      candidate.type === 'ElementNode' &&
      (candidate.tagName === 'Case' ||
        candidate.tagName === 'Match' ||
        candidate.tagName === 'Default')
  );

  const branches = elementChildren.filter(
    (entry) => entry.tagName === 'Case' || entry.tagName === 'Match'
  );
  const defaultBranch = elementChildren
    .filter((entry) => entry.tagName === 'Default')
    .at(-1);

  if (branches.length === 0) {
    return null;
  }

  const fallbackChildren: TemplateChildNode[] = defaultBranch?.children ?? [];

  // 取值匹配模式下，`<Case when>` 的表达式会被改写为与 `Switch value` 的严格相等比较。
  const resolveBranchCondition = (branch: ElementNode): string | null => {
    if (branch.tagName === 'Match') {
      return getAttributeExpression(branch, 'value');
    }

    const expectedExpression = getAttributeExpression(branch, 'when');

    if (!expectedExpression) {
      return null;
    }

    return switchValueExpression
      ? `(${switchValueExpression} === (${expectedExpression}))`
      : expectedExpression;
  };

  const buildNestedWhen = (index: number): ElementNode | null => {
    if (index >= branches.length) {
      return null;
    }

    const branchNode = branches[index];
    const whenExpression = resolveBranchCondition(branchNode);

    if (!whenExpression) {
      // 没有条件的分支无法参与判断，直接跳过继续看下一个分支。
      return buildNestedWhen(index + 1);
    }

    const next = buildNestedWhen(index + 1);
    const whenAttributes: AttributeNode[] = [
      createExpressionAttribute('value', whenExpression),
    ];
    if (mode) {
      whenAttributes.push(createStaticAttribute('mode', mode));
    }

    // 把当前分支包成 `When -> Then / Else` 结构，递归拼成链式条件树。
    // 这里选择先重写 AST，再复用既有 `When` lowering，避免出现两套 IfIR 语义分叉。
    const thenNode = createElementNode('Then', branchNode.children);
    const elseChildren = next ? [next] : fallbackChildren;
    const elseNode =
      elseChildren.length > 0 ? createElementNode('Else', elseChildren) : null;

    return createElementNode(
      'When',
      elseNode ? [thenNode, elseNode] : [thenNode],
      whenAttributes
    );
  };

  const syntheticRoot = buildNestedWhen(0);
  if (!syntheticRoot) {
    return null;
  }

  // 统一复用 `When` lowering，避免 `Switch` 维护另一套 IfIR 构建逻辑。
  return lowerWhenElement(
    syntheticRoot,
    path,
    slotIndex,
    lowerTemplateChildren
  );
};

export const lowerEachElement = (
  child: ElementNode,
  path: number[],
  slotIndex: number
): ListIR | null => {
  const itemsExpression = getAttributeExpression(child, 'value');

  if (!itemsExpression) {
    return null;
  }

  const renderChild = child.children.find(
    (candidate) => candidate.type === 'ExpressionNode'
  );
  const renderExpression =
    renderChild && renderChild.type === 'ExpressionNode'
      ? renderChild.expression
      : '(item) => item';
  const keyExpression = getAttributeExpression(child, 'key');
  const fallbackExpression = getAttributeExpression(child, 'fallback');
  const fallbackTemplateHtml = fallbackExpression
    ? (renderStaticTemplateFromExpression(fallbackExpression) ?? undefined)
    : undefined;

  if (keyExpression) {
    // 优先尝试把 keyed each 编译成“模板 + 绑定描述”，给运行时更多复用空间。
    const keyedTemplate = compileKeyedEachItemTemplate(renderExpression);

    if (keyedTemplate) {
      const keyedItemHoistName = `__each_item_${path.join('_') || 'root'}_${slotIndex}`;
      const bindingsExpression = keyedTemplate.bindings
        .map((binding) => {
          return `{ kind: ${JSON.stringify(binding.kind)}, slotIndex: ${binding.slotIndex}, path: [${binding.path.join(', ')}], evaluate: ${binding.evaluate}, name: ${binding.name ? JSON.stringify(binding.name) : 'undefined'}, unit: ${binding.unit ? JSON.stringify(binding.unit) : 'undefined'}, modifiers: ${JSON.stringify(binding.modifiers ?? [])}, directiveKind: ${binding.directiveKind ? JSON.stringify(binding.directiveKind) : 'undefined'} }`;
        })
        .join(', ');

      return {
        type: 'ListIR',
        path,
        slotIndex,
        // keyed-slots 形态会把 items / key / item template / bindings 一并交给运行时，
        // 让运行时既能按 key 追踪身份，又能复用编译期提取出的 item 模板。
        expression: `({ __lania_for: "keyed-slots", items: (${itemsExpression} ?? []), key: (${keyExpression}), template: ${keyedItemHoistName}, bindings: [${bindingsExpression}] })`,
        keyedItemTemplateHtml: keyedTemplate.templateHtml,
        keyedItemHoistName,
        fallbackTemplateHtml,
        fallbackHoistName: fallbackTemplateHtml
          ? `__each_fallback_slot_${path.join('_') || 'root'}_${slotIndex}`
          : undefined,
      };
    }
  }

  const slotsTemplate = compileKeyedEachItemTemplate(renderExpression);

  if (slotsTemplate) {
    // 即使没有显式 key，只要能编译出 item 模板，也尽量走 slots 形式提升复用性。
    const itemTemplateHoistName = `__each_item_${path.join('_') || 'root'}_${slotIndex}`;
    const bindingsExpression = slotsTemplate.bindings
      .map((binding) => {
        return `{ kind: ${JSON.stringify(binding.kind)}, slotIndex: ${binding.slotIndex}, path: [${binding.path.join(', ')}], evaluate: ${binding.evaluate}, name: ${binding.name ? JSON.stringify(binding.name) : 'undefined'}, unit: ${binding.unit ? JSON.stringify(binding.unit) : 'undefined'}, modifiers: ${JSON.stringify(binding.modifiers ?? [])}, directiveKind: ${binding.directiveKind ? JSON.stringify(binding.directiveKind) : 'undefined'} }`;
      })
      .join(', ');

    return {
      type: 'ListIR',
      path,
      slotIndex,
      // 无 key 的 slots 形式退化为按顺序更新，但仍能保留模板合同和绑定描述。
      expression: `({ __lania_for: "slots", items: (${itemsExpression} ?? []), template: ${itemTemplateHoistName}, bindings: [${bindingsExpression}] })`,
      itemTemplateHtml: slotsTemplate.templateHtml,
      itemTemplateHoistName,
      itemBindingsExpression: `[${bindingsExpression}]`,
      fallbackTemplateHtml,
      fallbackHoistName: fallbackTemplateHtml
        ? `__each_fallback_slot_${path.join('_') || 'root'}_${slotIndex}`
        : undefined,
    };
  }

  return {
    type: 'ListIR',
    path,
    slotIndex,
    // 最后才回退到最直接的列表表达式形式，保证任何 Each 至少都能被正确表示。
    expression: keyExpression
      ? `({ __lania_for: "keyed", items: (${itemsExpression} ?? []), render: (${renderExpression}), key: (${keyExpression}) })`
      : `(${itemsExpression} ?? []).map(${renderExpression})`,
    fallbackTemplateHtml,
    fallbackHoistName: fallbackTemplateHtml
      ? `__each_fallback_slot_${path.join('_') || 'root'}_${slotIndex}`
      : undefined,
  };
};
