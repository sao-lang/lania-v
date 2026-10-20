/**
 * JSX 模板解析器。
 *
 * 这个文件位于“函数组件 TSX AST”与“compiler-core 模板 IR”之间，是函数组件模板
 * 语义真正收口的地方。上游仍然是带有 TypeScript / JSX 词法细节的原始 AST，下游则只希望
 * 看到稳定、扁平、与语法糖无关的 `TemplateNode` 树，因此这里承担了较多“在入口处一次性
 * 收敛语义分歧”的工作。
 *
 * 除了常规节点转换，这里还同时负责几类强语义步骤：
 * 1. 归一化 JSX 文本空白、Fragment 与花括号表达式，屏蔽 TSX 词法差异；
 * 2. 兼容 `jsx-standard` 与 `directive-extended` 两种模板输入口径；
 * 3. 把 attribute 重新分类为普通属性、事件、指令，并在必要时展开对象糖衣；
 * 4. 尽早校验增强组件嵌套关系、对象语法静态形状、`html` 与 children 的互斥约束；
 * 5. 输出一棵只保留模板语义的树，供后续 compiler-core 直接构建模板 IR。
 *
 * 由于该文件仍然较长，注释会优先解释“为什么在解析阶段处理”和“产物需要满足什么约束”，
 * 便于后续继续拆分时，仍能看清每一段辅助逻辑在整条模板编译链路中的位置。
 */
import ts from 'typescript';

import {
  createEnhancedParentRequirementErrorMessage,
  getEnhancedComponentRegistryEntry,
  getRequiredEnhancedParentComponentName,
} from '@lania-v/shared';
import {
  analyzeTsxBindingName,
  DOM_EVENT_NAMES,
  type TsxBindingAnalysis,
  getJsxAttributeNameText,
} from '../analysis/binding';
import type { TsxTemplateSyntaxMode } from './template-mode';
import type {
  AttributeNode,
  DirectiveNode,
  ElementNode,
  EventNode,
  ExpressionNode,
  TemplateChildNode,
  TemplateNode,
  TextNode,
} from '@lania-v/compiler-core';

const normalizeJsxText = (text: string): string => {
  // JSX 里跨行空白会被压缩，这里按模板语义做同样的归一化。
  const normalized = text.replace(/\s+/g, ' ');
  return normalized.trim().length === 0 ? '' : normalized;
};

// JSX 普通元素和自闭合元素都统一抽取标签名文本，供属性解析和增强组件校验复用。
const getJsxTagNameText = (
  node: ts.JsxElement | ts.JsxSelfClosingElement
): string => {
  return ts.isJsxElement(node)
    ? node.openingElement.tagName.getText()
    : node.tagName.getText();
};

// `<Then>` / `<Else>` / `<Case>` 这类增强分支组件依赖严格父子结构，这里提前做结构校验。
const validateEnhancedBranchPlacement = (
  node: ts.JsxElement | ts.JsxSelfClosingElement | ts.JsxFragment,
  parentTagName: string | null = null
): void => {
  if (ts.isJsxFragment(node)) {
    node.children.forEach((child) => {
      if (
        ts.isJsxElement(child) ||
        ts.isJsxSelfClosingElement(child) ||
        ts.isJsxFragment(child)
      ) {
        validateEnhancedBranchPlacement(child, null);
      }
    });
    return;
  }

  const tagName = getJsxTagNameText(node);
  const requiredParentTagName = getRequiredEnhancedParentComponentName(tagName);
  if (requiredParentTagName && parentTagName !== requiredParentTagName) {
    throw new Error(createEnhancedParentRequirementErrorMessage(tagName)!);
  }

  if (ts.isJsxSelfClosingElement(node)) {
    return;
  }

  node.children.forEach((child) => {
    if (
      ts.isJsxElement(child) ||
      ts.isJsxSelfClosingElement(child) ||
      ts.isJsxFragment(child)
    ) {
      validateEnhancedBranchPlacement(child, tagName);
    }
  });
};

const createExpressionNode = (expression: string): ExpressionNode => {
  return {
    type: 'ExpressionNode',
    expression,
  };
};

const createTextNode = (value: string): TextNode => {
  return {
    type: 'TextNode',
    value,
  };
};

// attribute initializer 若是 `{expr}`，这里提取其源码文本，供后续节点记录使用。
const getJsxExpressionText = (
  initializer: ts.JsxAttribute['initializer'],
  sourceFile: ts.SourceFile
): string | null => {
  if (
    initializer &&
    ts.isJsxExpression(initializer) &&
    initializer.expression
  ) {
    return initializer.expression.getText(sourceFile);
  }

  return null;
};

// 有些能力需要继续分析表达式 AST 形状，例如对象字面量事件和 model 指令。
const getJsxExpressionNode = (
  initializer: ts.JsxAttribute['initializer']
): ts.Expression | null => {
  if (
    initializer &&
    ts.isJsxExpression(initializer) &&
    initializer.expression
  ) {
    return initializer.expression;
  }

  return null;
};

interface NormalizedJsxAttribute {
  // 这里的名字已经过扩展语法拼接恢复，可直接送入绑定名分析器。
  nameText: string;
  initializer: ts.JsxAttribute['initializer'];
}

// 这组辅助函数负责把 TSX 词法层面被拆开的扩展 attribute 名重新拼回编译器语义。
// 这几类绑定允许在 TSX 预处理后以多段 attribute 的形式重新拼回完整名字。
const shouldAttemptBindingMerge = (nameText: string): boolean => {
  return (
    nameText.startsWith('model:') ||
    nameText.startsWith('style:') ||
    DOM_EVENT_NAMES.has(nameText) ||
    looksLikeDirectiveExtendedEventToken(nameText)
  );
};

const canAppendBindingSegment = (nameText: string): boolean => {
  // 被拆出来的后续片段只能是“纯后缀 token”，避免把新的独立绑定错误拼接进去。
  return !nameText.includes(':') && !nameText.includes('.');
};

// 把 TSX 解析器看到的属性序列恢复成“编译器真正想分析的绑定名 + initializer”。
const normalizeJsxAttributeProperties = (
  attributes: ts.JsxAttributes,
  mode: TsxTemplateSyntaxMode
): NormalizedJsxAttribute[] => {
  if (mode !== 'directive-extended') {
    return attributes.properties.flatMap((property) => {
      if (!ts.isJsxAttribute(property)) {
        return [];
      }

      return [{
        nameText: getJsxAttributeNameText(property.name),
        initializer: property.initializer,
      }];
    });
  }

  const normalized: NormalizedJsxAttribute[] = [];

  // `directive-extended` 模式下，某些扩展属性名会在预处理阶段被拆段，这里顺序还原。
  for (let index = 0; index < attributes.properties.length; index += 1) {
    const property = attributes.properties[index];

    if (!ts.isJsxAttribute(property)) {
      continue;
    }

    const nameText = getJsxAttributeNameText(property.name);

    if (!shouldAttemptBindingMerge(nameText) || property.initializer) {
      normalized.push({
        nameText,
        initializer: property.initializer,
      });
      continue;
    }

    // 例如 `model:value.trim={x}` 可能在预处理后拆成多段，这里顺序合并回来。
    let mergedName = nameText;
    let initializer: ts.JsxAttribute['initializer'] = property.initializer;
    let cursor = index;

    while (cursor + 1 < attributes.properties.length) {
      const nextProperty = attributes.properties[cursor + 1];

      if (!ts.isJsxAttribute(nextProperty)) {
        break;
      }

      const nextNameText = getJsxAttributeNameText(nextProperty.name);

      if (!canAppendBindingSegment(nextNameText)) {
        break;
      }

      mergedName += `.${nextNameText}`;
      initializer = nextProperty.initializer;
      cursor += 1;

      if (nextProperty.initializer) {
        break;
      }
    }

    normalized.push({
      nameText: mergedName,
      initializer,
    });
    index = cursor;
  }

  return normalized;
};

const looksLikeDirectiveExtendedEventToken = (nameText: string): boolean => {
  // 扩展事件名的后续 token 允许 `:`，例如自定义事件或具名阶段；这里只做宽松词法过滤。
  return /^[a-z][a-z0-9:-]*$/.test(nameText);
};

const classifyDirectiveKind = (
  analysis: TsxBindingAnalysis
): DirectiveNode['kind'] => {
  // 绑定名分析阶段会产出更细的种类，这里再映射成模板 IR 约定的指令 kind。
  switch (analysis.kind) {
    case 'if-directive':
      return 'if';
    case 'bind-directive':
      return 'bind';
    case 'model-directive':
      return 'model';
    case 'html-directive':
      return 'html';
    case 'class-directive':
      return 'class';
    case 'style-directive':
      return 'style';
    case 'use-directive':
      return 'use';
    case 'ref':
      return 'ref';
    default:
      return 'unknown';
  }
};

const isIntrinsicElementTag = (tagName: string): boolean => {
  // 增强组件虽然名字也可能看起来像标签，但它们不走原生元素那套属性/事件语义。
  if (getEnhancedComponentRegistryEntry(tagName)) {
    return false;
  }

  return /^[a-z]/.test(tagName);
};

const PROP_LIKE_BINDINGS = new Set(['value', 'checked', 'selected']);

/** `client:<priority>` 允许的 island 水合优先级。 */
const ISLAND_HYDRATION_PRIORITIES = new Set([
  'eager',
  'idle',
  'visible',
  'interaction',
]);
const KEYBOARD_EVENT_NAMES = new Set(['keydown', 'keyup', 'keypress']);
const EVENT_LISTENER_MODIFIERS = new Set(['once', 'capture', 'passive']);
const EVENT_SYSTEM_MODIFIERS = new Set(['ctrl', 'shift', 'alt', 'meta']);

/**
 * `prevent` 的语义扩展：`prevent.self` / `prevent.immediate` 只在指定条件满足时调用
 * `preventDefault()`，这样既保留原有 `prevent` 行为，又能表达“仅自己触发”“仅当前监听链”
 * 这类常见诉求，同时避免把它们误当成键盘键位修饰符。
 */
const PREVENT_SCOPES = new Set(['self', 'immediate']);

const EVENT_MOUSE_BUTTONS = new Set(['left', 'middle', 'right']);

/** 需要额外监听才能实现的提示性修饰符，生成阶段会拆成多个事件槽位。 */
const EVENT_HINT_MODIFIERS = new Set(['debounce', 'throttle']);

interface EventModifierLowering {
  modifiers: string[];
  listener?: EventNode['listener'];
  preventScopes: string[];
  hints: string[];
}

/**
 * 事件表达式本身也可能携带 `withEventHint(fn, 'debounce')` 包装。
 * 这里把它拆成“原始处理器 + 提示名”，保证模板 slot 与动态组件两条路径行为一致。
 */
const prepareEventSource = (source: string): { source: string; hints: string[] } => {
  const hints: string[] = [];
  const hintPattern = /\bwithEventHint\(\s*([\s\S]*?),\s*'([^']+)'\s*\)/g;

  const prepared = source.replace(hintPattern, (match, handler: string, hint: string) => {
    if (!EVENT_HINT_MODIFIERS.has(hint) || hints.includes(hint)) {
      return match;
    }

    hints.push(hint);
    return handler.trim();
  });

  return { source: hints.length > 0 ? prepared : source, hints };
};

const mergeHints = (
  left: readonly string[] | undefined,
  right: readonly string[]
): string[] | undefined => {
  const merged = [...(left ?? [])];

  right.forEach((hint) => {
    if (!merged.includes(hint)) {
      merged.push(hint);
    }
  });

  return merged.length > 0 ? merged : undefined;
};

// 把 `once` / `capture` / `passive` 拆到 listener 选项，其余归入模板修饰符。
const lowerEventModifiers = (
  modifiers: readonly string[],
  eventName: string,
  tagName: string,
  expression: string
): EventModifierLowering => {
  const normalized: string[] = [];
  const listener: NonNullable<EventNode['listener']> = {};
  const preventScopes: string[] = [];
  // `debounce` / `throttle` 既可以写在事件名后缀，也可以包装在处理器表达式里，两者统一收敛。
  const prepared = prepareEventSource(expression);
  const hints: string[] = [...prepared.hints];
  let previousWasPrevent = false;

  modifiers.forEach((modifier) => {
    const lowerModifier = modifier.toLowerCase();
    const isPreventScope = previousWasPrevent && PREVENT_SCOPES.has(lowerModifier);
    previousWasPrevent = lowerModifier === 'prevent';

    // `once` / `capture` / `passive` 既可以写在修饰符里，也可以写成 listener 选项。
    const isListenerModifier =
      EVENT_LISTENER_MODIFIERS.has(lowerModifier) ||
      (lowerModifier.startsWith('listener:') &&
        EVENT_LISTENER_MODIFIERS.has(lowerModifier.slice('listener:'.length)));

    if (!isPreventScope && isListenerModifier) {
      const listenerName = lowerModifier.startsWith('listener:')
        ? lowerModifier.slice('listener:'.length)
        : lowerModifier;
      listener[listenerName as 'once' | 'capture' | 'passive'] = true;
      return;
    }

    // `.debounce` / `.throttle` 需要额外监听，交由生成阶段拆分。
    if (!isPreventScope && EVENT_HINT_MODIFIERS.has(lowerModifier)) {
      hints.push(lowerModifier);
      return;
    }

    if (!isPreventScope && EVENT_SYSTEM_MODIFIERS.has(lowerModifier)) {
      normalized.push(`system:${lowerModifier}`);
      return;
    }

    // `left` / `middle` / `right` 是鼠标键过滤，不能被键盘键位规则改写。
    if (!isPreventScope && EVENT_MOUSE_BUTTONS.has(lowerModifier)) {
      normalized.push(`button:${lowerModifier}`);
      return;
    }

    if (
      !isPreventScope &&
      KEYBOARD_EVENT_NAMES.has(eventName) &&
      !EVENT_RESERVED_MODIFIERS.has(lowerModifier) &&
      !lowerModifier.startsWith('key:') &&
      !lowerModifier.startsWith('system:') &&
      !lowerModifier.startsWith('button:')
    ) {
      normalized.push(`key:${lowerModifier}`);
      return;
    }

    if (isPreventScope) {
      preventScopes.push(lowerModifier);
      return;
    }

    normalized.push(lowerModifier);
  });

  const usesKeyboardModifiers = normalized.some(
    (modifier) => modifier === 'enter' || modifier.startsWith('key:') || modifier.startsWith('system:')
  );

  if (usesKeyboardModifiers && !KEYBOARD_EVENT_NAMES.has(eventName)) {
    throw createTemplateParseError(tagName, `on${eventName}`, 'keyboard modifiers are only valid on keyboard events.');
  }

  return {
    modifiers: normalized,
    listener: Object.keys(listener).length > 0 ? listener : undefined,
    preventScopes,
    hints,
  };
};

const EVENT_RESERVED_MODIFIERS = new Set([
  'stop',
  'prevent',
  'self',
  'enter',
  'immediate',
  'passive',
  'left',
  'middle',
  'right',
]);

// `style` / `use` / `model` 三类对象糖衣都在模板解析阶段展开，避免把语法分歧传到下游 IR。
// `style={{ width: size, height.px: n }}` 会在这里拆成多个 style 指令，便于后续统一序列化。
const collectStyleObjectDirectives = (
  expression: ts.Expression,
  sourceFile: ts.SourceFile
): DirectiveNode[] | null => {
  if (!ts.isObjectLiteralExpression(expression)) {
    return null;
  }

  const directives: DirectiveNode[] = [];

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
      return null;
    }

    const [styleName, unit] = keyName.split('.');
    const exprText = ts.isShorthandPropertyAssignment(property)
      ? property.name.text
      : property.initializer.getText(sourceFile);

    directives.push({
      type: 'DirectiveNode',
      kind: 'style',
      name: styleName,
      expression: exprText,
      modifiers: [],
      unit: unit || undefined,
    });
  }

  return directives;
};

// `use={{ tooltip: expr }}` 会在这里展开成多个 use 指令节点。
const collectUseObjectDirectives = (
  expression: ts.Expression,
  sourceFile: ts.SourceFile,
  tagName: string
): DirectiveNode[] | null => {
  if (!ts.isObjectLiteralExpression(expression)) {
    return null;
  }

  assertStaticObjectLiteralShape(expression, tagName, 'use');

  const directives: DirectiveNode[] = [];

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

    // FC use 只接受静态指令名，不接受 computed key。
    if (!keyName) {
      return null;
    }

    const exprText = ts.isShorthandPropertyAssignment(property)
      ? property.name.text
      : property.initializer.getText(sourceFile);

    directives.push({
      type: 'DirectiveNode',
      kind: 'use',
      name: keyName,
      expression: exprText,
      modifiers: [],
    });
  }

  return directives;
};

const getStaticObjectPropertyName = (propertyName: ts.PropertyName): string | null => {
  // 只接受能静态确定名字的 key；computed key 会在更上层的 shape 校验里被拦截。
  if (ts.isIdentifier(propertyName) || ts.isStringLiteral(propertyName)) {
    return propertyName.text;
  }

  return null;
};

// 统一按静态 key 查找对象字面量属性，便于事件/model/use 的对象语法共享这套读取逻辑。
const getObjectLiteralProperty = (
  expression: ts.ObjectLiteralExpression,
  name: string
): ts.ObjectLiteralElementLike | undefined => {
  return expression.properties.find((property) => {
    if (ts.isSpreadAssignment(property)) {
      return false;
    }

    if (ts.isShorthandPropertyAssignment(property)) {
      return property.name.text === name;
    }

    if (ts.isPropertyAssignment(property) || ts.isMethodDeclaration(property)) {
      return getStaticObjectPropertyName(property.name) === name;
    }

    return false;
  });
};

const readObjectPropertyExpression = (
  property: ts.ObjectLiteralElementLike | undefined
): ts.Expression | null => {
  if (!property) {
    return null;
  }

  if (ts.isShorthandPropertyAssignment(property)) {
    // `{ foo }` 在 AST 中是 shorthand，这里把它视为读取同名标识符表达式。
    return property.name;
  }

  if (ts.isPropertyAssignment(property)) {
    return property.initializer;
  }

  return null;
};

const isTrueLikeLiteral = (expression: ts.Expression | null): boolean => {
  // 这里故意只把字面量 `true` 当作开启标记，不接受 truthy 表达式，避免模板语义变得模糊。
  return expression?.kind === ts.SyntaxKind.TrueKeyword;
};

const readStaticStringLiteral = (expression: ts.Expression | null): string | null => {
  // 某些配置位要求在编译期静态可知，因此同时接受普通字符串和无插值模板串。
  if (
    expression &&
    (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression))
  ) {
    return expression.text;
  }

  return null;
};

const readStringArrayLiteral = (expression: ts.Expression | null): string[] | null => {
  if (!expression || !ts.isArrayLiteralExpression(expression)) {
    return null;
  }

  const values: string[] = [];
  for (const entry of expression.elements) {
    // 这里只接受静态字符串数组，方便把键盘修饰符等信息稳定写入模板元数据。
    if (!ts.isStringLiteral(entry) && !ts.isNoSubstitutionTemplateLiteral(entry)) {
      return null;
    }
    values.push(entry.text);
  }

  return values;
};

const createTemplateParseError = (tagName: string, bindingName: string, detail: string): Error => {
  // 统一错误格式，方便上层把模板绑定错误稳定映射回组件上下文。
  return new Error(`<${tagName}> ${bindingName}: ${detail}`);
};

// 若对象语法出现 spread 或 computed key，直接在模板解析阶段报错，避免语义继续扩散。
const assertStaticObjectLiteralShape = (
  expression: ts.ObjectLiteralExpression,
  tagName: string,
  bindingName: string
): void => {
  for (const property of expression.properties) {
    if (ts.isSpreadAssignment(property)) {
      throw createTemplateParseError(
        tagName,
        bindingName,
        'spread properties are not supported in object syntax.'
      );
    }

    if (ts.isShorthandPropertyAssignment(property)) {
      continue;
    }

    if (ts.isPropertyAssignment(property)) {
      if (ts.isComputedPropertyName(property.name)) {
        throw createTemplateParseError(
          tagName,
          bindingName,
          'computed property names are not supported in object syntax.'
        );
      }
      continue;
    }

    throw createTemplateParseError(
      tagName,
      bindingName,
      'object syntax only supports static key/value entries.'
    );
  }
};

// `html` 会接管元素内部内容，因此禁止再同时声明普通子节点。
const assertHtmlDirectiveChildExclusion = (
  tagName: string,
  directives: readonly DirectiveNode[],
  children: readonly TemplateChildNode[]
): void => {
  const htmlDirective = directives.find((directive) => directive.kind === 'html');
  if (!htmlDirective) {
    return;
  }

  if (children.length > 0) {
    throw createTemplateParseError(tagName, 'html', '`html` cannot be used together with child nodes.');
  }
};

// 标准 TSX 下支持 `onClick={{ handler, modifiers, listener }}` 对象写法，这里负责归一化。
const collectEventObjectBinding = (
  eventName: string,
  expression: ts.ObjectLiteralExpression,
  sourceFile: ts.SourceFile,
  tagName: string,
  component: boolean
): Pick<EventNode, 'expression' | 'modifiers' | 'listener' | 'hints'> => {
  // 事件对象语法是“标准 TSX 补齐模板能力”的入口，因此先把形状约束卡死再往下解包。
  assertStaticObjectLiteralShape(expression, tagName, `on${eventName}`);

  const handlerExpression = readObjectPropertyExpression(
    getObjectLiteralProperty(expression, 'handler')
  );

  if (!handlerExpression) {
    throw createTemplateParseError(tagName, `on${eventName}`, 'event object must include `handler`.');
  }

  const modifiers: string[] = [];
  const modifiersExpression = readObjectPropertyExpression(
    getObjectLiteralProperty(expression, 'modifiers')
  );

  if (modifiersExpression) {
    if (!ts.isObjectLiteralExpression(modifiersExpression)) {
      throw createTemplateParseError(tagName, `on${eventName}`, '`modifiers` must be an object literal.');
    }

    assertStaticObjectLiteralShape(modifiersExpression, tagName, `on${eventName}`);

    const pushBooleanModifier = (name: 'stop' | 'prevent' | 'self'): void => {
      if (isTrueLikeLiteral(readObjectPropertyExpression(getObjectLiteralProperty(modifiersExpression, name)))) {
        modifiers.push(name);
      }
    };

    pushBooleanModifier('stop');
    pushBooleanModifier('prevent');
    pushBooleanModifier('self');

    // 提示性修饰符在对象写法里也支持，与后缀写法等价。
    (['debounce', 'throttle', 'immediate', 'passive'] as const).forEach((name) => {
      if (isTrueLikeLiteral(readObjectPropertyExpression(getObjectLiteralProperty(modifiersExpression, name)))) {
        modifiers.push(name);
      }
    });

    // 对象写法的布尔项也必须走与后缀写法相同的降级通道，
    // 否则 `enter` / `system` / `button` 这类修饰符在 IR 里会丢失键位语义。
    (
      [
        ['enter', 'key:enter'],
        ['immediate', 'immediate'],
        ['passive', 'passive'],
      ] as const
    ).forEach(([name, modifier]) => {
      if (isTrueLikeLiteral(readObjectPropertyExpression(getObjectLiteralProperty(modifiersExpression, name)))) {
        modifiers.push(modifier);
      }
    });

    // 鼠标键与 prevent 作用域都支持直接写成布尔项，与后缀写法一一对应。
    (['left', 'middle', 'right'] as const).forEach((name) => {
      if (isTrueLikeLiteral(readObjectPropertyExpression(getObjectLiteralProperty(modifiersExpression, name)))) {
        modifiers.push(`button:${name}`);
      }
    });

    (
      [
        ['preventSelf', 'prevent.self'],
        ['preventImmediate', 'prevent.immediate'],
      ] as const
    ).forEach(([name, modifier]) => {
      if (isTrueLikeLiteral(readObjectPropertyExpression(getObjectLiteralProperty(modifiersExpression, name)))) {
        modifiers.push(...modifier.split('.'));
      }
    });

    const keys = readStringArrayLiteral(
      readObjectPropertyExpression(getObjectLiteralProperty(modifiersExpression, 'keys'))
    );
    if (keys) {
      // 键盘键统一在编译期降成 `key:*` 修饰符，运行时无需再解析数组字面量。
      modifiers.push(...keys.map((key) => `key:${key.toLowerCase()}`));
    } else if (getObjectLiteralProperty(modifiersExpression, 'keys')) {
      throw createTemplateParseError(tagName, `on${eventName}`, '`modifiers.keys` must be a string literal array.');
    }

    const systemExpression = readObjectPropertyExpression(
      getObjectLiteralProperty(modifiersExpression, 'system')
    );
    if (systemExpression) {
      if (!ts.isObjectLiteralExpression(systemExpression)) {
        throw createTemplateParseError(tagName, `on${eventName}`, '`modifiers.system` must be an object literal.');
      }

      assertStaticObjectLiteralShape(systemExpression, tagName, `on${eventName}`);

      (['ctrl', 'shift', 'alt', 'meta'] as const).forEach((name) => {
        if (isTrueLikeLiteral(readObjectPropertyExpression(getObjectLiteralProperty(systemExpression, name)))) {
          modifiers.push(`system:${name}`);
        }
      });
    }
  }

  const listenerExpression = readObjectPropertyExpression(
    getObjectLiteralProperty(expression, 'listener')
  );
  let listener: EventNode['listener'];
  if (listenerExpression) {
    if (!ts.isObjectLiteralExpression(listenerExpression)) {
      throw createTemplateParseError(tagName, `on${eventName}`, '`listener` must be an object literal.');
    }

    assertStaticObjectLiteralShape(listenerExpression, tagName, `on${eventName}`);

    // listener 选项和系统修饰符拆开保存，后续运行时更容易直接映射到 addEventListener 选项。
    // 这样模板修饰符仍保留模板语义，浏览器 listener option 则走原生通道。
    const nextListener: NonNullable<EventNode['listener']> = {};
    (['once', 'capture', 'passive'] as const).forEach((name) => {
      if (isTrueLikeLiteral(readObjectPropertyExpression(getObjectLiteralProperty(listenerExpression, name)))) {
        nextListener[name] = true;
      }
    });
    listener = Object.keys(nextListener).length > 0 ? nextListener : undefined;
  }

  // 对象写法最终统一成后缀修饰符序列，校验与降级只保留一份实现。
  const normalized = normalizeEventBindingMetadata(
    eventName,
    modifiers,
    tagName,
    component,
    handlerExpression.getText(sourceFile)
  );

  return {
    expression: handlerExpression.getText(sourceFile),
    modifiers: normalized.modifiers,
    listener: normalized.listener ?? listener,
    hints: normalized.hints,
  };
};

// 标准 TSX 下的 `model={{ ... }}` 在这里被归一化成编译器内部的 model 指令节点。
const collectModelObjectDirective = (
  expression: ts.ObjectLiteralExpression,
  sourceFile: ts.SourceFile,
  tagName: string
): DirectiveNode => {
  assertStaticObjectLiteralShape(expression, tagName, 'model');

  const targetExpression = readObjectPropertyExpression(
    getObjectLiteralProperty(expression, 'target')
  );
  const sourceExpression = readObjectPropertyExpression(
    getObjectLiteralProperty(expression, 'source')
  );

  if (targetExpression && sourceExpression) {
    throw createTemplateParseError(tagName, 'model', '`target` and `source` cannot be used together.');
  }

  if (!targetExpression && !sourceExpression) {
    throw createTemplateParseError(tagName, 'model', 'model object must include `target` or `source`.');
  }

  const propExpression = readObjectPropertyExpression(
    getObjectLiteralProperty(expression, 'prop')
  );
  const prop = readStaticStringLiteral(propExpression) ?? 'value';
  if (propExpression && !readStaticStringLiteral(propExpression)) {
    throw createTemplateParseError(tagName, 'model', '`prop` must be a string literal.');
  }

  const modifiersExpression = readObjectPropertyExpression(
    getObjectLiteralProperty(expression, 'modifiers')
  );
  const modifiers: string[] = [];

  if (modifiersExpression) {
    if (!ts.isObjectLiteralExpression(modifiersExpression)) {
      throw createTemplateParseError(tagName, 'model', '`modifiers` must be an object literal.');
    }

    assertStaticObjectLiteralShape(modifiersExpression, tagName, 'model');

    const modifierNames = [
      'trim',
      'number',
      'lazy',
      'checked',
      'boolean',
      'empty',
      'debounce',
    ] as const;

    modifierNames.forEach((name) => {
      if (isTrueLikeLiteral(readObjectPropertyExpression(getObjectLiteralProperty(modifiersExpression, name)))) {
        modifiers.push(name);
      }
    });

    // `debounceMs` 不是布尔开关，单独读取数值字面量。
    const debounceMsExpression = readObjectPropertyExpression(
      getObjectLiteralProperty(modifiersExpression, 'debounceMs')
    );
    const debounceMs = debounceMsExpression ? Number(debounceMsExpression.getText(sourceFile)) : NaN;

    if (debounceMsExpression && Number.isFinite(debounceMs)) {
      modifiers.push(`debounceMs:${debounceMs}`);
    }
  }

  // 布尔语义的复选框修饰符直接推导出 prop，避免用户同时写 `prop` 与 `checked`。
  const resolvedProp = prop === 'value' && modifiers.includes('checked') ? 'checked' : prop;

  return {
    type: 'DirectiveNode',
    kind: 'model',
    name: resolvedProp,
    expression: expression.getText(sourceFile),
    modifiers,
  };
};

// 把修饰符数组拆成“事件系统修饰符”和“listener 选项”两部分，便于运行时消费。
const normalizeEventBindingMetadata = (
  eventName: string,
  modifiers: readonly string[],
  tagName: string,
  component: boolean,
  expression: string
): Pick<EventNode, 'modifiers' | 'listener' | 'hints' | 'expression'> => {
  if (component && modifiers.length > 0) {
    throw createTemplateParseError(tagName, `on${eventName}`, 'component events only support `listener` options.');
  }

  const lowered = lowerEventModifiers(modifiers, eventName, tagName, expression);

  // `prevent.self` / `prevent.immediate` 在 IR 里统一归一为 `prevent:<scope>`，
  // 避免运行时再从修饰符序列里回溯“它前面是不是 prevent”。
  const normalizedModifiers: string[] = [];
  lowered.modifiers.forEach((modifier) => {
    normalizedModifiers.push(modifier);

    if (modifier === 'prevent') {
      lowered.preventScopes.forEach((scope) => normalizedModifiers.push(`prevent:${scope}`));
    }
  });

  return {
    modifiers: normalizedModifiers,
    listener: lowered.listener,
    hints: lowered.hints.length > 0 ? lowered.hints : undefined,
    expression: prepareEventSource(expression).source,
  };
};

// 这里是模板解析的主分发点：先做绑定名语义分析，再决定落入 attributes/events/directives。
// 属性解析是模板解析的核心步骤：它把 TSX attribute 切分成属性、事件与指令三类。
const parseJsxAttributes = (
  attributes: ts.JsxAttributes,
  sourceFile: ts.SourceFile,
  mode: TsxTemplateSyntaxMode,
  tagName: string
): Pick<
  ElementNode,
  'attributes' | 'events' | 'directives' | 'spreadAttributes' | 'island'
> => {
  const attributeNodes: AttributeNode[] = [];
  const eventNodes: EventNode[] = [];
  const directiveNodes: DirectiveNode[] = [];
  const spreadAttributes: string[] = [];
  const intrinsicTag = isIntrinsicElementTag(tagName);
  let island: ElementNode['island'];

  // spread 与普通 attribute 的顺序信息在这里不保留；运行时会先展开 spread，
  // 再由显式 props / 事件 / 指令覆盖，保证显式绑定优先。
  attributes.properties.forEach((property) => {
    if (ts.isJsxSpreadAttribute(property)) {
      spreadAttributes.push(property.expression.getText(sourceFile));
    }
  });

  normalizeJsxAttributeProperties(attributes, mode).forEach((property) => {
    // `client:<priority>` 是 island 声明，不参与 props，也不允许用在原生标签上。
    if (property.nameText.startsWith('client:')) {
      if (intrinsicTag) {
        throw createTemplateParseError(
          tagName,
          property.nameText,
          '`client:*` island directives are only supported on component tags.'
        );
      }

      const priority = property.nameText.slice('client:'.length);

      if (!ISLAND_HYDRATION_PRIORITIES.has(priority)) {
        throw createTemplateParseError(
          tagName,
          property.nameText,
          `Unknown island priority "${priority}". Use one of: ${[
            ...ISLAND_HYDRATION_PRIORITIES,
          ].join(', ')}.`
        );
      }

      island = { priority };
      return;
    }
    // 先把绑定名分析成统一语义，再决定它应落到属性、事件还是指令数组。
    const analysis = analyzeTsxBindingName(property.nameText, {
      mode,
      intrinsicElement: intrinsicTag,
    });
    const expressionText = getJsxExpressionText(property.initializer, sourceFile);
    const expressionNode = getJsxExpressionNode(property.initializer);

    switch (analysis.kind) {
      case 'dom-event':
      case 'component-event':
        if (!expressionText) {
          // 事件没有处理函数时直接忽略，保持和原始模板“未绑定即无事件”的语义一致。
          return;
        }

        if (mode === 'jsx-standard' && expressionNode && ts.isObjectLiteralExpression(expressionNode)) {
          // 标准 TSX 额外支持对象事件语法，用来把模板级修饰符能力折叠回 JSX 表达式。
          const normalizedEvent = collectEventObjectBinding(
            analysis.bindingName,
            expressionNode,
            sourceFile,
            tagName,
            analysis.kind === 'component-event'
          );

          // `handler: withEventHint(fn, 'debounce')` 这类包装写法在编译期拆回“处理器 + 提示”。
          const hinted = prepareEventSource(normalizedEvent.expression);

          eventNodes.push({
            type: 'EventNode',
            name: analysis.bindingName,
            expression: hinted.source,
            modifiers: normalizedEvent.modifiers,
            listener: normalizedEvent.listener,
            hints: mergeHints(normalizedEvent.hints, hinted.hints),
            component: analysis.kind === 'component-event',
          });
          return;
        }

        const normalizedEvent = normalizeEventBindingMetadata(
          analysis.bindingName,
          analysis.modifiers,
          tagName,
          analysis.kind === 'component-event',
          expressionText
        );

        eventNodes.push({
          type: 'EventNode',
          name: analysis.bindingName,
          expression: normalizedEvent.expression,
          modifiers: normalizedEvent.modifiers,
          listener: normalizedEvent.listener,
          hints: normalizedEvent.hints,
          component: analysis.kind === 'component-event',
        });
        return;
      case 'if-directive':
      case 'bind-directive':
      case 'model-directive':
      case 'html-directive':
      case 'class-directive':
      case 'style-directive':
      case 'use-directive':
      case 'ref':
        if (!expressionText) {
          // 指令统一要求显式表达式，缺值时不隐式补默认行为。
          return;
        }

        // 标准 TSX 下 `model` 保留对象语法入口；扩展语法则仍走绑定名分析后的通用分支。
        if (mode === 'jsx-standard' && intrinsicTag && analysis.kind === 'model-directive') {
          if (!expressionNode || !ts.isObjectLiteralExpression(expressionNode)) {
            throw createTemplateParseError(tagName, 'model', 'TSX `model` must use an object literal.');
          }

          // `model` 在标准 TSX 中只有对象入口，避免与普通属性赋值语义混淆。
          directiveNodes.push(collectModelObjectDirective(expressionNode, sourceFile, tagName));
          return;
        }

        directiveNodes.push({
          type: 'DirectiveNode',
          kind: classifyDirectiveKind(analysis),
          name: analysis.bindingName,
          expression: expressionText,
          modifiers: analysis.modifiers,
          unit: analysis.unit,
        });
        return;

      case 'style-object':
        if (!intrinsicTag || !expressionNode) {
          break;
        }

        const styleDirectives = collectStyleObjectDirectives(expressionNode, sourceFile);
        if (styleDirectives) {
          directiveNodes.push(...styleDirectives);
          return;
        }
        break;

      default:
        break;
    }

    if (mode === 'jsx-standard' && intrinsicTag) {
      // `use` / `html` / prop-like bind 都是标准 TSX 模式下对原生标签补出来的模板糖衣。
      // 它们只对原生标签生效，组件标签仍优先按 props / component event 语义处理。
      if (analysis.bindingName === 'use' && expressionNode) {
        if (!ts.isObjectLiteralExpression(expressionNode)) {
          throw createTemplateParseError(tagName, 'use', 'TSX `use` must use an object literal.');
        }

        const useDirectives = collectUseObjectDirectives(expressionNode, sourceFile, tagName);
        if (useDirectives) {
          directiveNodes.push(...useDirectives);
          return;
        }
      }

      if (analysis.bindingName === 'html' && expressionText) {
        directiveNodes.push({
          type: 'DirectiveNode',
          kind: 'html',
          name: 'html',
          expression: expressionText,
          modifiers: [],
        });
        return;
      }

      if (analysis.bindingName === 'className') {
        // 标准 TSX 下对齐浏览器实际属性名，模板 IR 里统一记为 `class`。
        if (expressionText) {
          attributeNodes.push({
            type: 'AttributeNode',
            name: 'class',
            value: createExpressionNode(expressionText),
            static: false,
          });
          return;
        }
      }

      if (PROP_LIKE_BINDINGS.has(analysis.bindingName) && expressionText) {
        directiveNodes.push({
          type: 'DirectiveNode',
          kind: 'bind',
          name: analysis.bindingName,
          expression: expressionText,
          modifiers: [],
        });
        return;
      }
    }

    if (!property.initializer) {
      // 无值属性视为静态布尔属性。
      attributeNodes.push({
        type: 'AttributeNode',
        name:
          mode === 'jsx-standard' && intrinsicTag && analysis.bindingName === 'className'
            ? 'class'
            : analysis.bindingName,
        value: null,
        static: true,
      });
      return;
    }

    if (ts.isStringLiteral(property.initializer)) {
      attributeNodes.push({
        type: 'AttributeNode',
        name:
          mode === 'jsx-standard' && intrinsicTag && analysis.bindingName === 'className'
            ? 'class'
            : analysis.bindingName,
        value: property.initializer.text,
        static: true,
      });
      return;
    }

    if (expressionText) {
      attributeNodes.push({
        type: 'AttributeNode',
        name: analysis.bindingName,
        value: createExpressionNode(expressionText),
        static: false,
      });
    }
  });

  if (intrinsicTag && spreadAttributes.length > 0) {
    // 原生标签的 spread 需要运行时逐 key 建 slot；当前主线只支持组件 props 展开，
    // 先显式报错，避免属性被静默丢弃。
    throw createTemplateParseError(
      tagName,
      'spread',
      'Spread attributes are only supported on component tags. Pass explicit attributes on intrinsic elements.'
    );
  }

  return {
    attributes: attributeNodes,
    events: eventNodes,
    directives: directiveNodes,
    spreadAttributes,
    island,
  };
};

// 子树递归阶段只保留模板语义节点，不再保留 JSX 自带的 fragment/attribute 壳层信息。
// 子节点解析负责把 TS JSX 节点递归压平为模板树节点。
const parseJsxChild = (
  node: ts.Node,
  sourceFile: ts.SourceFile,
  mode: TsxTemplateSyntaxMode
): TemplateChildNode[] => {
  if (ts.isJsxText(node)) {
    // JSX 文本节点需要先按模板语义压缩空白，再决定是否保留。
    // 这里用 `getFullText`：TS 会把紧邻前一个元素的空白算进前导 trivia，
    // 只用 `getText` 会丢掉 `</span> | next` 这类空格，渲染结果与 JSX 语义不一致。
    const value = normalizeJsxText(node.getFullText(sourceFile));
    return value.length > 0 ? [createTextNode(value)] : [];
  }

  if (ts.isJsxExpression(node)) {
    if (!node.expression) {
      return [];
    }

    // 花括号表达式统一收敛成模板表达式节点，具体语义留给后续绑定分析与代码生成。
    return [createExpressionNode(node.expression.getText(sourceFile))];
  }

  if (ts.isJsxFragment(node)) {
    // Fragment 自身不落节点，只展开其子节点。
    return node.children.flatMap((child) => parseJsxChild(child, sourceFile, mode));
  }

  if (ts.isJsxSelfClosingElement(node)) {
    const tagName = node.tagName.getText(sourceFile);
    const parsedAttributes = parseJsxAttributes(node.attributes, sourceFile, mode, tagName);

    // 自闭合节点没有 children，但属性、事件、指令仍要完整解析后再落入模板树。
    return [
      {
        type: 'ElementNode',
        tagName,
        attributes: parsedAttributes.attributes,
        events: parsedAttributes.events,
        directives: parsedAttributes.directives,
        spreadAttributes: parsedAttributes.spreadAttributes,
        island: parsedAttributes.island,
        children: [],
        selfClosing: true,
      },
    ];
  }

  if (!ts.isJsxElement(node)) {
    return [];
  }

  const parsedAttributes = parseJsxAttributes(
    node.openingElement.attributes,
    sourceFile,
    mode,
    node.openingElement.tagName.getText(sourceFile)
  );
  // 这里先得到完整 children，再把“属性侧信息”和“子树侧信息”做交叉约束检查。
  const children = node.children.flatMap((child) => parseJsxChild(child, sourceFile, mode));
  // 非自闭合元素只有在子节点递归完成后，才能判断 `html` 指令是否与 children 冲突。
  assertHtmlDirectiveChildExclusion(
    node.openingElement.tagName.getText(sourceFile),
    parsedAttributes.directives,
    children
  );

  return [
    {
      type: 'ElementNode',
      tagName: node.openingElement.tagName.getText(sourceFile),
      attributes: parsedAttributes.attributes,
      events: parsedAttributes.events,
      directives: parsedAttributes.directives,
      spreadAttributes: parsedAttributes.spreadAttributes,
      island: parsedAttributes.island,
      children,
      selfClosing: false,
    },
  ];
};

export const unwrapJsxExpression = (
  expression: ts.Expression
):
  | ts.JsxElement
  | ts.JsxSelfClosingElement
  | ts.JsxFragment
  | undefined => {
  if (ts.isParenthesizedExpression(expression)) {
    // 支持 `return (<div />)` 这类被括号包裹的 JSX。
    return unwrapJsxExpression(expression.expression);
  }

  if (
    ts.isJsxElement(expression) ||
    ts.isJsxSelfClosingElement(expression) ||
    ts.isJsxFragment(expression)
  ) {
    return expression;
  }

  return undefined;
};

export const parseReturnedJsxTemplate = (
  sourceFile: ts.SourceFile,
  expression: ts.Expression,
  mode: TsxTemplateSyntaxMode = 'jsx-standard'
): TemplateNode => {
  const jsxRoot = unwrapJsxExpression(expression);

  if (!jsxRoot) {
    throw new Error('component must return a JSX element or fragment.');
  }

  // 在真正产出模板节点前先校验增强组件的嵌套关系，避免把结构错误带进后续 IR 阶段。
  validateEnhancedBranchPlacement(jsxRoot);

  // 根节点即使原始返回的是单元素，也统一包装成 `TemplateNode.children[]` 入口形态。
  // 根节点统一包成 TemplateNode，便于后续编译阶段只处理一种入口形态。
  return {
    type: 'TemplateNode',
    children: parseJsxChild(jsxRoot, sourceFile, mode),
  };
};
