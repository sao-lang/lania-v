/**
 * keyed each 模板编译辅助。
 *
 * 这个文件服务于“可 keyed 的列表项模板”提取场景。
 * 当编译器识别到 `items.map(item => <Row ... />)` 这类表达式时，
 * 需要把列表项渲染函数进一步拆成两部分：
 * 1. 可复用的静态 HTML 模板；
 * 2. 一组依附在该模板上的动态绑定描述。
 *
 * 后续运行时在 keyed diff 过程中，就可以复用静态模板骨架，只对绑定值做重算和重放。
 * 因此这里本质上是在做“列表项局部模板编译”。
 *
 * 需要注意的是，这里只接受足够规整、可以安全静态提取的 JSX 片段；
 * 一旦遇到无法稳定还原成“静态 HTML + 动态绑定表”的写法，就会整体回退为 `null`，
 * 交给更通用但也更保守的列表渲染路径。
 *
 * 因而这里的策略本质上是“宁可少识别，也不误识别”：
 * - 能精确拆开的属性、事件、指令就记录成 binding；
 * - 不能稳定静态化的写法立即终止本次提取；
 * - 保证 keyed diff 复用的模板骨架永远是可信的。
 */
import type { DirectiveNode } from '../../../ast';
import { parseTypeScriptSource } from '../../../transform/parse-typescript-source';
import ts from 'typescript';

// keyed item 内允许直接识别为 DOM 事件的名字集合。
const KEYED_ITEM_DOM_EVENT_NAMES = new Set([
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

type KeyedEachTemplateBinding = {
  slotIndex: number;
  path: number[];
  kind: 'text' | 'attr' | 'prop' | 'class' | 'style' | 'event' | 'directive' | 'ref';
  evaluate: string;
  name?: string;
  unit?: string;
  modifiers?: string[];
  directiveKind?: DirectiveNode['kind'];
};

type KeyedEachTemplate = {
  templateHtml: string;
  bindings: KeyedEachTemplateBinding[];
};

// 把表达式最外层括号剥掉，并确认它最终是否真的是 JSX 根节点。
const unwrapJsxFromExpression = (
  expression: ts.Expression
):
  | ts.JsxElement
  | ts.JsxSelfClosingElement
  | ts.JsxFragment
  | null => {
  let current: ts.Expression = expression;

  while (ts.isParenthesizedExpression(current)) {
    current = current.expression;
  }

  return ts.isJsxElement(current) || ts.isJsxSelfClosingElement(current) || ts.isJsxFragment(current)
    ? current
    : null;
};

// 和模板解析器保持一致，keyed item 中的 JSX 文本也按 JSX 规则折叠空白。
const normalizeJsxTextValue = (text: string): string => {
  const normalized = text.replace(/\s+/g, ' ');
  return normalized.trim().length === 0 ? '' : normalized;
};

// 预处理阶段转义过的绑定名需要先还原，后面才能继续按 `class:` / `style:` / `on:` 识别。
const restoreBindingName = (name: string): string => {
  return name.replace(/__LANIA_DOT__/g, '.');
};

// keyed item 内的事件写法兼容多种形式，这里统一解析成事件名 + 修饰符列表。
const parseKeyedItemEventBinding = (
  rawName: string
): { name: string; modifiers: string[] } | null => {
  if (rawName.startsWith('on:')) {
    const [eventName, ...modifiers] = rawName.slice('on:'.length).split('.');
    return eventName ? { name: eventName, modifiers } : null;
  }

  if (/^on[A-Z]/.test(rawName)) {
    return {
      name: `${rawName.charAt(2).toLowerCase()}${rawName.slice(3)}`,
      modifiers: [],
    };
  }

  if (KEYED_ITEM_DOM_EVENT_NAMES.has(rawName)) {
    return {
      name: rawName,
      modifiers: [],
    };
  }

  if (
    !rawName.includes(':') &&
    rawName.includes('.') &&
    !rawName.startsWith('class.') &&
    !rawName.startsWith('style.')
  ) {
    const [eventName, ...modifiers] = rawName.split('.');
    return eventName ? { name: eventName, modifiers } : null;
  }

  return null;
};

type KeyedStyleObjectEntry = {
  name: string;
  unit?: string;
  expression: string;
};

const collectKeyedItemStyleObjectEntries = (
  expression: ts.Expression,
  sourceFile: ts.SourceFile
): KeyedStyleObjectEntry[] | null => {
  // `style={{ width: x, height.px: y }}` 这类对象写法需要拆成多条 style 绑定描述。
  if (!ts.isObjectLiteralExpression(expression)) {
    return null;
  }

  const entries: KeyedStyleObjectEntry[] = [];

  for (const property of expression.properties) {
    if (!ts.isPropertyAssignment(property) && !ts.isShorthandPropertyAssignment(property)) {
      return null;
    }

    const keyName = ts.isShorthandPropertyAssignment(property)
      ? property.name.text
      : ts.isIdentifier(property.name)
        ? property.name.text
        : ts.isStringLiteral(property.name)
          ? property.name.text
          : null;

    if (!keyName) {
      // style 对象 key 若无法收敛成稳定字符串，就不能安全拆成细粒度 style binding。
      return null;
    }

    const [name, unit] = keyName.split('.');
    const exprText = ts.isShorthandPropertyAssignment(property)
      ? property.name.text
      : property.initializer.getText(sourceFile);

    entries.push({
      name,
      unit: unit || undefined,
      expression: exprText,
    });
  }
  // 这里只返回可逐项写入 style 的描述，不在这个阶段保留原对象结构。

  return entries;
};

// 遍历单个 JSX 元素的 attribute，把其中可静态化的部分转成 HTML 后缀，
// 把动态部分转成 keyed item 绑定描述对象。
const collectKeyedItemAttributeBindings = (
  attributes: ts.JsxAttributes,
  sourceFile: ts.SourceFile,
  elementPath: number[],
  slotIndexRef: { value: number },
  bindings: KeyedEachTemplateBinding[]
): string | null => {
  // 返回值是“还能留在静态模板里的 attribute 后缀”；动态部分则写入 bindings。
  const parts = attributes.properties.flatMap((prop) => {
    if (!ts.isJsxAttribute(prop) || !prop.name) {
      return [];
    }

    const name = restoreBindingName(prop.name.getText(sourceFile));
    // JSX 的 `className` 落到 HTML 时必须写成 `class`，否则会生成非法属性名。
    const htmlName = name === 'className' ? 'class' : name;
    const value = prop.initializer;

    if (!value) {
      return [htmlName];
    }

    if (ts.isStringLiteral(value)) {
      return [`${htmlName}="${value.text}"`];
    }

    if (!ts.isJsxExpression(value) || !value.expression) {
      return [null];
    }

    if (name === 'className') {
      // JSX 的 `className` 在列表项模板里最终回落成普通 attr/class 写入。
      const slotIndex = slotIndexRef.value;
      bindings.push({
        kind: 'attr',
        slotIndex,
        path: elementPath,
        name: 'class',
        evaluate: value.expression.getText(sourceFile),
      });
      slotIndexRef.value += 1;
      return [];
    }

    if (name === 'style') {
      if (!ts.isObjectLiteralExpression(value.expression)) {
        // keyed item 里只支持对象字面量 style，避免运行时再解释复杂结构。
        // 一旦出现无法静态展开的 style，整个 keyed 模板提取就终止，退回通用列表路径。
        return [null];
      }

      const styleEntries = collectKeyedItemStyleObjectEntries(value.expression, sourceFile);
      if (!styleEntries) {
        return [null];
      }

      styleEntries.forEach((directive: KeyedStyleObjectEntry) => {
        const slotIndex = slotIndexRef.value;
        bindings.push({
          kind: 'style',
          slotIndex,
          path: elementPath,
          name: directive.name,
          unit: directive.unit,
          evaluate: directive.expression,
        });
        slotIndexRef.value += 1;
      });
      return [];
    }

    if (name === 'value' || name === 'checked' || name === 'selected') {
      // 这几个字段在运行时更接近 property 写入，而不是 HTML attribute。
      const slotIndex = slotIndexRef.value;
      bindings.push({
        kind: 'prop',
        slotIndex,
        path: elementPath,
        name,
        evaluate: value.expression.getText(sourceFile),
      });
      slotIndexRef.value += 1;
      return [];
    }

    if (name.startsWith('bind:')) {
      // `bind:` 在列表项模板里退化成 prop 写入，双向同步细节交给运行时层处理。
      const slotIndex = slotIndexRef.value;
      bindings.push({
        kind: 'prop',
        slotIndex,
        path: elementPath,
        name: name.slice('bind:'.length) || 'value',
        evaluate: value.expression.getText(sourceFile),
      });
      slotIndexRef.value += 1;
      return [];
    }

    // 下面几类扩展语法都会被拆成独立 binding，让静态模板壳只保留纯 HTML 结构。
    if (name.startsWith('class:')) {
      const slotIndex = slotIndexRef.value;
      bindings.push({
        kind: 'class',
        slotIndex,
        path: elementPath,
        name: name.slice('class:'.length),
        evaluate: value.expression.getText(sourceFile),
      });
      slotIndexRef.value += 1;
      return [];
    }

    if (name.startsWith('style:')) {
      const slotIndex = slotIndexRef.value;
      const descriptor = name.slice('style:'.length);
      const [styleName, unit] = descriptor.split('.');
      bindings.push({
        kind: 'style',
        slotIndex,
        path: elementPath,
        name: styleName,
        unit: unit || undefined,
        evaluate: value.expression.getText(sourceFile),
      });
      slotIndexRef.value += 1;
      return [];
    }

    const eventBinding = parseKeyedItemEventBinding(name);
    if (eventBinding) {
      // 事件绑定会被抽成独立 binding，静态模板中不直接内联 listener。
      const slotIndex = slotIndexRef.value;
      bindings.push({
        kind: 'event',
        slotIndex,
        path: elementPath,
        name: eventBinding.name,
        modifiers: eventBinding.modifiers,
        evaluate: value.expression.getText(sourceFile),
      });
      slotIndexRef.value += 1;
      return [];
    }

    if (name === 'ref') {
      const slotIndex = slotIndexRef.value;
      bindings.push({
        kind: 'ref',
        slotIndex,
        path: elementPath,
        evaluate: value.expression.getText(sourceFile),
      });
      slotIndexRef.value += 1;
      return [];
    }

    if (name.startsWith('model:')) {
      const slotIndex = slotIndexRef.value;
      const [bindingName, ...modifiers] = name.slice('model:'.length).split('.');
      bindings.push({
        kind: 'directive',
        slotIndex,
        path: elementPath,
        name: bindingName || 'value',
        directiveKind: 'model',
        modifiers,
        evaluate: value.expression.getText(sourceFile),
      });
      slotIndexRef.value += 1;
      return [];
    }

    if (name.startsWith('use:')) {
      const slotIndex = slotIndexRef.value;
      const [bindingName, ...modifiers] = name.slice('use:'.length).split('.');
      bindings.push({
        kind: 'directive',
        slotIndex,
        path: elementPath,
        name: bindingName || '',
        directiveKind: 'use',
        modifiers,
        evaluate: value.expression.getText(sourceFile),
      });
      slotIndexRef.value += 1;
      return [];
    }

    if (name.includes(':') || name.includes('.')) {
      // 其余无法精确识别的扩展语法，先按 unknown directive 留给运行时兜底处理。
      const slotIndex = slotIndexRef.value;
      bindings.push({
        kind: 'directive',
        slotIndex,
        path: elementPath,
        name,
        directiveKind: 'unknown',
        evaluate: value.expression.getText(sourceFile),
      });
      slotIndexRef.value += 1;
      return [];
    }

    const slotIndex = slotIndexRef.value;
    // 默认兜底为普通 attr 绑定。
    bindings.push({
      kind: 'attr',
      slotIndex,
      path: elementPath,
      name,
      evaluate: value.expression.getText(sourceFile),
    });
    slotIndexRef.value += 1;
    return [];
  });

  if (parts.some((part) => part === null)) {
    // 只要有一个 attribute 无法静态化，整棵 keyed item 模板就放弃静态提取。
    // 这里选择“整棵回退”而不是部分成功，是为了保持 slot path 与 HTML 壳结构严格一致。
    return null;
  }

  return parts.length > 0 ? ` ${parts.join(' ')}` : '';
};

// 递归把 JSX 根节点转换成“静态 HTML + keyed item 绑定描述”。
const renderJsxNodeToTemplateHtmlWithBindings = (
  node: ts.JsxElement | ts.JsxSelfClosingElement | ts.JsxFragment,
  sourceFile: ts.SourceFile,
  parentPath: number[],
  slotIndexRef: { value: number },
  bindings: KeyedEachTemplateBinding[]
): string | null => {
  let domIndex = 0;

  const renderChildren = (children: readonly ts.JsxChild[], elementPath: number[]): string | null => {
    // childDomIndex 只统计真正落成 DOM 的节点，用来和后续 slot path 保持同一套坐标。
    let childDomIndex = 0;
    const parts: string[] = [];

    for (const child of children) {
      if (ts.isJsxText(child)) {
        const value = normalizeJsxTextValue(child.getText(sourceFile));
        if (value.length > 0) {
          parts.push(value);
          childDomIndex += 1;
        }
        continue;
      }

      if (ts.isJsxExpression(child)) {
        if (!child.expression) {
          continue;
        }

        // 子文本表达式会在静态模板中先放占位符，再生成一条 text binding。
        const slotIndex = slotIndexRef.value;
        bindings.push({
          kind: 'text',
          slotIndex,
          path: [...elementPath, childDomIndex],
          evaluate: child.expression.getText(sourceFile),
        });
        parts.push(`__LANIA_SLOT_${slotIndex}__`);
        slotIndexRef.value += 1;
        childDomIndex += 1;
        continue;
      }

      if (ts.isJsxFragment(child)) {
        // fragment 自身不占 DOM 节点，只把内部 children 平铺展开。
        const fragmentHtml = renderChildren(child.children, elementPath);
        if (fragmentHtml === null) {
          return null;
        }
        parts.push(fragmentHtml);
        continue;
      }

      if (ts.isJsxSelfClosingElement(child)) {
        const tagName = child.tagName.getText(sourceFile);
        const path = [...elementPath, childDomIndex];
        const attrSuffix = collectKeyedItemAttributeBindings(
          child.attributes,
          sourceFile,
          path,
          slotIndexRef,
          bindings
        );
        if (attrSuffix === null) {
          return null;
        }
        parts.push(`<${tagName}${attrSuffix}></${tagName}>`);
        childDomIndex += 1;
        continue;
      }

      if (ts.isJsxElement(child)) {
        const tagName = child.openingElement.tagName.getText(sourceFile);
        const path = [...elementPath, childDomIndex];
        const attrSuffix = collectKeyedItemAttributeBindings(
          child.openingElement.attributes,
          sourceFile,
          path,
          slotIndexRef,
          bindings
        );
        if (attrSuffix === null) {
          return null;
        }

        const inner = renderChildren(child.children, path);
        if (inner === null) {
          return null;
        }
        parts.push(`<${tagName}${attrSuffix}>${inner}</${tagName}>`);
        childDomIndex += 1;
      }
    }

    return parts.join('');
  };

  if (ts.isJsxFragment(node)) {
    // fragment 不额外产出包裹节点，因此路径继续沿用父级 path。
    return renderChildren(node.children, parentPath);
  }

  if (ts.isJsxSelfClosingElement(node)) {
    const tagName = node.tagName.getText(sourceFile);
    const attrSuffix = collectKeyedItemAttributeBindings(
      node.attributes,
      sourceFile,
      parentPath,
      slotIndexRef,
      bindings
    );
    if (attrSuffix === null) {
      return null;
    }
    return `<${tagName}${attrSuffix}></${tagName}>`;
  }

  const tagName = node.openingElement.tagName.getText(sourceFile);
  // 根元素自身也要占用一个 DOM 层级，因此这里先把 parentPath 扩成当前根路径。
  const path = [...parentPath, domIndex];
  const attrSuffix = collectKeyedItemAttributeBindings(
    node.openingElement.attributes,
    sourceFile,
    path,
    slotIndexRef,
    bindings
  );
  if (attrSuffix === null) {
    return null;
  }
  const childrenHtml = renderChildren(node.children, path);
  if (childrenHtml === null) {
    return null;
  }
  return `<${tagName}${attrSuffix}>${childrenHtml}</${tagName}>`;
};

// 从 `items.map(item => <Row ... />)` 这类 render expression 中提取可 keyed 的模板描述。
export const compileKeyedEachItemTemplate = (renderExpression: string): KeyedEachTemplate | null => {
  try {
    const source = parseTypeScriptSource(
      '__lania_each_item__.tsx',
      `const __lania_each_render__ = (${renderExpression});`
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

    if (!initializer || !(ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer))) {
      // 只有“函数 -> JSX”的 render 表达式才有意义，其他形式直接放弃 keyed 模板提取。
      return null;
    }

    const parameters = initializer.parameters
      .map((param) => (ts.isIdentifier(param.name) ? param.name.text : null))
      .filter((name): name is string => Boolean(name));
    const paramList = parameters.length > 0 ? parameters.join(', ') : 'item';

    const bodyExpression = (() => {
      if (ts.isBlock(initializer.body)) {
        // 支持 `item => { return <div /> }` 这种块体写法。
        const returnStatement = initializer.body.statements.find(ts.isReturnStatement);
        const expr = returnStatement?.expression;
        return expr ?? null;
      }
      return initializer.body;
    })();

    if (!bodyExpression) {
      return null;
    }

    const jsxRoot = unwrapJsxFromExpression(bodyExpression);
    if (!jsxRoot) {
      return null;
    }

    const slotIndexRef = { value: 0 };
    const bindings: KeyedEachTemplateBinding[] = [];
    const html = renderJsxNodeToTemplateHtmlWithBindings(
      jsxRoot,
      source,
      [],
      slotIndexRef,
      bindings
    );

    if (!html) {
      // 提取过程中任一节点失败都会返回 null，调用方据此降级为普通 each 渲染。
      return null;
    }

    // 列表项内每条 binding 的 evaluate 最终都改写成 `(item, index, ...) => expr` 的形式。
    const normalizedBindings = bindings.map((binding) => ({
      ...binding,
      // 运行时 keyed diff 会把 item/index 等参数实参传入，这里提前固化成统一回调签名。
      evaluate: `(${paramList}) => (${binding.evaluate})`,
    }));

    return {
      templateHtml: html,
      bindings: normalizedBindings,
    };
  } catch {
    return null;
  }
};
