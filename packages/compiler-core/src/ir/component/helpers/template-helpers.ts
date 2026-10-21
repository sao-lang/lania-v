import type {
  DirectiveNode,
  ElementNode,
  EventNode,
  ExpressionNode,
  TemplateChildNode,
} from '../../../ast';
import { parseTypeScriptSource } from '../../../transform/parse-typescript-source';
import {
  getEnhancedComponentRegistryEntry,
  isWhenBranchEnhancedComponentName,
} from '@lania-v/shared';
import ts from 'typescript';

/**
 * 模板 lowering 辅助函数。
 *
 * 这些工具函数服务于 `ir/component/lowering/*` 阶段，职责是把 AST 层模板节点上的
 * 一些通用判断与归一化逻辑抽出来复用，例如：
 * - 属性值是静态字符串还是表达式；
 * - JSX/TSX 表达式能否静态渲染为 HTML；
 * - 某个表达式是否具有“列表渲染”语义；
 * - 事件、指令、`When/Then/Else` 分支该怎样转成更稳定的中间表示。
 *
 * 这些 helper 不直接生成完整 IR，但它们决定了 lowering 阶段如何识别模板中的特殊语义。
 *
 * 换句话说，这里更像是一层“语义判别与值归一化工具箱”：
 * - 上游 AST 只负责忠实保存模板源码结构；
 * - 下游 lowering 需要的是更稳定、可预测、便于 codegen 消费的中间信息；
 * - 本文件就负责在二者之间补上这层转换粘合剂。
 *
 * 由于后续很多决策都会依赖这里的判断结果，所以这里的策略整体偏保守：
 * 只在可以确定不改变语义时做静态化、列表识别或分支提取，
 * 一旦判断不稳，就返回 `null` / `false` 交给更通用的动态路径处理。
 *
 * 这也意味着本文件虽然大多是“小函数”，但它们实际上定义了 lowering 的很多边界条件：
 * - 什么表达式还能视为静态模板；
 * - 什么结构可以提炼成列表/条件协议；
 * - 什么信息必须继续原样留给动态运行时路径。
 */

const getEnhancedWhenBranchKind = (
  name: string
): 'truthy' | 'fallback' | null => {
  if (name === 'Then') {
    return 'truthy';
  }

  if (name === 'Else') {
    return 'fallback';
  }

  return null;
};

// 属性值在 AST 层可能是字符串、表达式节点或 null，这里提供一个统一的类型守卫。
export const isExpressionAttributeValue = (
  value: string | ExpressionNode | null
): value is ExpressionNode => {
  return value !== null && typeof value !== 'string';
};

// 读取属性值时统一返回“可直接拼进源码的表达式字符串”。
// 静态字符串会在这里被转成 JSON 字面量，避免上层重复处理引号转义。
export const getAttributeExpression = (
  node: ElementNode,
  name: string
): string | null => {
  const attribute = node.attributes.find((candidate) => candidate.name === name);

  if (!attribute || attribute.value === null) {
    return null;
  }

  if (typeof attribute.value === 'string') {
    return JSON.stringify(attribute.value);
  }

  return attribute.value.expression;
};

// 某些分支只接受纯字符串属性值，这里显式把表达式属性过滤掉。
export const getAttributeStringValue = (
  node: ElementNode,
  name: string
): string | null => {
  const attribute = node.attributes.find((candidate) => candidate.name === name);

  if (!attribute || attribute.value === null) {
    return null;
  }

  return typeof attribute.value === 'string' ? attribute.value : null;
};

// 把元素属性统一整理成 `[name, value]` 对，供后续构造 props/object 表达式复用。
export const getElementAttributeEntries = (
  node: ElementNode,
  excludedNames: readonly string[] = []
): Array<[string, string]> => {
  return node.attributes.flatMap((attribute) => {
    if (excludedNames.includes(attribute.name)) {
      return [];
    }

    if (attribute.value === null) {
      return [[attribute.name, 'true']];
    }

    if (typeof attribute.value === 'string') {
      return [[attribute.name, JSON.stringify(attribute.value)]];
    }

    return [[attribute.name, attribute.value.expression]];
  });
};

// JSX 文本会天然折叠空白；这里复刻这种行为，避免静态渲染结果和真实 JSX 语义不一致。
const normalizeJsxText = (text: string): string => {
  const normalized = text.replace(/\s+/g, ' ');
  return normalized.trim().length === 0 ? '' : normalized;
};

// 把 JSX 属性初始化器尽量降成静态值；一旦发现动态表达式，就返回 null 表示无法静态化。
const renderJsxAttributeValue = (value: ts.JsxAttributeValue | undefined): string | true | null => {
  if (!value) {
    // 裸属性在 JSX 中等价于布尔 true，例如 `<input disabled />`。
    return true;
  }

  if (ts.isStringLiteral(value)) {
    return value.text;
  }

  if (ts.isJsxExpression(value)) {
    if (!value.expression) {
      // 空表达式 `{}` 视为空字符串，和 JSX 输出行为对齐。
      return '';
    }

    if (
      ts.isStringLiteral(value.expression) ||
      ts.isNoSubstitutionTemplateLiteral(value.expression) ||
      ts.isNumericLiteral(value.expression)
    ) {
      return value.expression.text;
    }

    if (value.expression.kind === ts.SyntaxKind.TrueKeyword) {
      return 'true';
    }

    if (value.expression.kind === ts.SyntaxKind.FalseKeyword) {
      return 'false';
    }

    // 其他表达式一律视为动态值，宁可放弃静态化，也不在这里偷跑求值。
    return null;
  }

  return null;
};

// 递归尝试把一段 JSX AST 静态渲染成 HTML 字符串。
// 这主要用于增强组件和条件/列表分支的“静态骨架”提取。
const renderStaticJsxNode = (node: ts.Node): string | null => {
  if (ts.isJsxText(node)) {
    return normalizeJsxText(node.getText());
  }

  if (ts.isJsxExpression(node)) {
    if (!node.expression) {
      return '';
    }

    if (
      ts.isStringLiteral(node.expression) ||
      ts.isNoSubstitutionTemplateLiteral(node.expression) ||
      ts.isNumericLiteral(node.expression)
    ) {
      return node.expression.text;
    }

    if (node.expression.kind === ts.SyntaxKind.TrueKeyword) {
      return 'true';
    }

    if (node.expression.kind === ts.SyntaxKind.FalseKeyword) {
      return 'false';
    }

    // JSX child 中只接受最简单的静态原子值，复杂表达式交给运行时渲染路径。
    return null;
  }

  if (ts.isJsxFragment(node)) {
    // Fragment 自身不落成标签，只负责把 children 串接成连续 HTML。
    const children = node.children
      .map((child) => renderStaticJsxNode(child))
      .filter((child): child is string => child !== null);

    return children.length === node.children.length ? children.join('') : null;
  }

  if (ts.isJsxSelfClosingElement(node)) {
    const tagName = node.tagName.getText();
    const enhancedEntry = getEnhancedComponentRegistryEntry(tagName);

    if (
      enhancedEntry?.staticRenderMode === 'flatten' ||
      enhancedEntry?.staticRenderMode === 'children-only'
    ) {
      // 某些增强组件在静态模式下自身不占 DOM，只透传或展开子内容。
      return '';
    }

    // 只要有一个属性无法降成静态值，就说明这整个 JSX 节点不能安全静态化。
    const attributes = node.attributes.properties.map((property) => {
      if (!ts.isJsxAttribute(property)) {
        // spread attribute 无法安全静态展开，因此这里直接判定整节点不可静态化。
        return null;
      }

      const value = renderJsxAttributeValue(property.initializer);

      if (value === null) {
        return null;
      }

      return value === true
        ? property.name.getText()
        : `${property.name.getText()}="${value}"`;
    });

    if (attributes.some((value) => value === null)) {
      return null;
    }

    const suffix = attributes.length > 0 ? ` ${attributes.join(' ')}` : '';
    return `<${tagName}${suffix}></${tagName}>`;
  }

  if (ts.isJsxElement(node)) {
    const tagName = node.openingElement.tagName.getText();
    // 开始标签和自闭合标签共享同一套“属性必须可静态化”的判断标准。
    const attributes = node.openingElement.attributes.properties.map((property) => {
      if (!ts.isJsxAttribute(property)) {
        return null;
      }

      const value = renderJsxAttributeValue(property.initializer);

      if (value === null) {
        return null;
      }

      return value === true
        ? property.name.getText()
        : `${property.name.getText()}="${value}"`;
    });

    if (attributes.some((value) => value === null)) {
      return null;
    }

    const children = node.children.map((child) => renderStaticJsxNode(child));

    if (children.some((child) => child === null)) {
      // 只要任一子节点无法静态渲染，整棵 JSX 子树都回退为动态模板。
      return null;
    }

    const enhancedEntry = getEnhancedComponentRegistryEntry(tagName);

    if (
      enhancedEntry?.staticRenderMode === 'flatten' ||
      enhancedEntry?.staticRenderMode === 'children-only'
    ) {
      // 对“只保留 children”的增强组件，静态 HTML 只保留其子树内容。
      return children.join('');
    }

    const suffix = attributes.length > 0 ? ` ${attributes.join(' ')}` : '';
    return `<${tagName}${suffix}>${children.join('')}</${tagName}>`;
  }

  return null;
};

// 把字符串表达式包成一段临时 TSX，再借助 TypeScript parser 识别其是否能静态展开。
export const renderStaticTemplateFromExpression = (expression: string): string | null => {
  try {
    // 先把用户表达式包成一段合法 TSX，再借助 TS parser 做结构识别而不是手写字符串分析。
    const source = parseTypeScriptSource(
      '__lania_enhanced_component__.tsx',
      `const __lania_template__ = (${expression});`
    );
    const statement = source.statements[0];

    if (
      !statement ||
      !ts.isVariableStatement(statement) ||
      statement.declarationList.declarations.length !== 1
    ) {
      return null;
    }

    let initializer = statement.declarationList.declarations[0]?.initializer;

    while (initializer && ts.isParenthesizedExpression(initializer)) {
      initializer = initializer.expression;
    }

    if (!initializer) {
      return null;
    }

    // 这里最终只接受一个可被 `renderStaticJsxNode` 消化的初始化表达式根节点。
    return renderStaticJsxNode(initializer);
  } catch {
    // 静态化失败不应打断编译流程，调用方只需把它视为“动态模板”。
    return null;
  }
};

// 裸表达式如果本质上是 `xxx.map(...)`，lowering 会把它识别成列表 slot，而非普通文本表达式。
export const isListExpression = (expression: string): boolean => {
  try {
    // 这里只识别最常见、最稳定的 `expr.map(...)` 形态，避免把普通调用误判为列表语义。
    const ast = parseTypeScriptSource(
      '__lania_list_expression__.tsx',
      `const __lania_expr__ = (${expression});`
    );
    const statement = ast.statements[0];

    if (
      !statement ||
      !ts.isVariableStatement(statement) ||
      statement.declarationList.declarations.length !== 1
    ) {
      return false;
    }

    let initializer = statement.declarationList.declarations[0]?.initializer;

    while (initializer && ts.isParenthesizedExpression(initializer)) {
      initializer = initializer.expression;
    }

    // 这里只看“最终根调用是不是 `.map(...)`”，不继续追踪更复杂的链式推导。
    return Boolean(
      initializer &&
        ts.isCallExpression(initializer) &&
        ts.isPropertyAccessExpression(initializer.expression) &&
        initializer.expression.name.text === 'map'
    );
  } catch {
    return false;
  }
};

// 生成 `IfIR` 静态骨架时，只保留不会影响结构判断的静态属性，去掉事件等行为语义。
export const toStaticElementNode = (node: ElementNode): ElementNode => {
  return {
    ...node,
    attributes: node.attributes.filter((attribute) => attribute.static),
    events: [],
    children: node.children,
  };
};

// 把静态属性记录重新序列化回 HTML 片段。
export const renderStaticAttributes = (attributes: Record<string, string | true>): string => {
  const pairs = Object.entries(attributes).map(([name, value]) => {
    return value === true ? name : `${name}="${value}"`;
  });

  return pairs.length > 0 ? ` ${pairs.join(' ')}` : '';
};

// 当前约定中，带连字符的标签名默认视为静态组件标签。
export const isStaticComponentTag = (tagName: string): boolean => {
  return tagName.includes('-');
};

// 事件/指令 lowering 目前主要做“带路径的结构搬运”，便于后续统一进入 IR。
export const lowerEvent = (event: EventNode, path: number[]) => {
  return {
    name: event.name,
    expression: event.expression,
    modifiers: event.modifiers,
    listener: event.listener,
    hints: event.hints,
    component: event.component,
    path,
  };
};

export const lowerDirective = (directive: DirectiveNode, path: number[]) => {
  return {
    kind: directive.kind,
    name: directive.name,
    expression: directive.expression,
    modifiers: directive.modifiers,
    unit: directive.unit,
    path,
  };
};

// `When` 支持两种写法：
// 1. 直接把子节点都视为 truthy 分支；
// 2. 用 `<Then>` / `<Else>` 显式拆分真分支和 fallback 分支。
export const resolveWhenBranches = (
  child: ElementNode
): {
  truthyChildren: TemplateChildNode[];
  fallbackChildren: TemplateChildNode[];
} => {
  const branchElements = child.children.filter(
    (candidate): candidate is ElementNode =>
      candidate.type === 'ElementNode' &&
      isWhenBranchEnhancedComponentName(candidate.tagName)
  );

  if (branchElements.length === 0) {
    // 未显式写 `<Then>` / `<Else>` 时，约定整组 children 都属于 truthy 分支。
    return {
      truthyChildren: child.children,
      fallbackChildren: [],
    };
  }

  // 只提取 `Then` / `Else` 的 children，自身包装标签不会进入最终分支子树。
  const truthyChildren = branchElements
    .filter((candidate) => getEnhancedWhenBranchKind(candidate.tagName) === 'truthy')
    .flatMap((candidate) => candidate.children);
  const fallbackChildren = branchElements
    .filter((candidate) => getEnhancedWhenBranchKind(candidate.tagName) === 'fallback')
    .flatMap((candidate) => candidate.children);

  return {
    truthyChildren,
    fallbackChildren,
  };
};
