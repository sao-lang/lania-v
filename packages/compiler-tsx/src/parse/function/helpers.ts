/**
 * 函数组件解析辅助工具。
 *
 * 这个文件集中放置函数组件解析阶段反复复用的“判定规则”“命名约定”和“源码文本提取工具”。
 * 上层入口解析希望把“组件长什么样”“哪些调用仍被支持”“哪些局部信息需要被后续阶段复用”
 * 这些共识沉淀在一处，避免采集器、绑定改写器、模板解析器分别维护各自的一套口径。
 *
 * 当前主要覆盖四类能力：
 * 1. 识别什么样的函数或 `defineComponent(...)` 包装可以视为组件入口；
 * 2. 检查生命周期 hook 是否仍受支持，并尽早给出迁移提示；
 * 3. 从函数签名中收集 props 与 context.emit 的可访问别名；
 * 4. 从返回语句中抽出 JSX 模板，交给模板解析器继续处理。
 *
 * 它本身不直接生成最终 `ComponentDeclaration`，但定义了整个函数组件入口解析的静态边界。
 */
import ts from 'typescript';

import { type SignalDeclaration } from '@lania-v/compiler-core';
import { parseReturnedJsxTemplate } from '../template';
import { resolveImportedTypeDeclaration } from './imported-types';

export type FunctionComponentLike =
  ts.FunctionDeclaration | ts.FunctionExpression | ts.ArrowFunction;

export interface ResolvedFunctionComponent {
  name: string;
  declaration: FunctionComponentLike;
  options?: ts.ObjectLiteralExpression;
  /** 是否由 `export default` 指定；有默认导出时它就是编译入口。 */
  isDefaultExport?: boolean;
}

/** 打印重写后的 AST，尽量保留原始注释。 */
export const printer = ts.createPrinter({
  removeComments: false,
});

/**
 * 当前支持识别的响应式工厂与生命周期 API。
 *
 * 这些集合既服务于解析阶段的“声明采集”，也服务于后续依赖分析阶段：
 * 某些工厂会返回 Signal-like 可调用对象，slot/updater 需要靠这里的名单把更新器挂到
 * 正确的响应式来源上。
 */
export const SIGNAL_FACTORIES = new Set([
  'createSignal',
  'readonly',
  'createDeferred',
  // `@lania/store` 的 atom 与派生 atom 都是 Signal 形态，可直接参与模板订阅。
  'createAtom',
  'createDerivedAtom',
]);
export const COMPUTED_FACTORIES = new Set(['computed', 'createMemo']);
export const EFFECT_FACTORIES = new Set(['effect', 'createEffect']);
// `createRef` 声明会被改写成普通实例字段，因此不属于信号类响应式来源。
export const REF_FACTORIES = new Set(['createRef']);
export const FUNCTION_LIFECYCLE_HOOKS = new Set([
  'onMount',
  'onMounted',
  'onCleanup',
  'onUnmounted',
  'onUpdated',
]);
export const REMOVED_FUNCTION_LIFECYCLE_HOOKS = new Set([
  'onUpdate',
  'onBeforeUpdate',
  'onError',
  'onAdopted',
  'onAttributeChanged',
]);
export const FUNCTION_LIFECYCLE_HOOK_ALIASES = new Map<string, string>([
  ['onMounted', 'onMount'],
  ['onUnmounted', 'onCleanup'],
]);

// 旧生命周期的迁移提示集中放在这里，保证解析阶段与测试断言看到同一套文案。
const REMOVED_FUNCTION_LIFECYCLE_HOOK_MESSAGES = new Map<string, string>([
  [
    'onUpdate',
    'FC lifecycle hook `onUpdate` has been removed in v0.2. Use `onUpdated` instead.',
  ],
  [
    'onBeforeUpdate',
    'FC lifecycle hook `onBeforeUpdate` has been removed in v0.2. Use `onUpdated` instead.',
  ],
  [
    'onError',
    'FC lifecycle hook `onError` has been removed in v0.2. Use `ErrorBoundary` instead.',
  ],
  [
    'onAdopted',
    'FC lifecycle hook `onAdopted` is no longer part of the v0.2 core API. Move it to host-layer code instead.',
  ],
  [
    'onAttributeChanged',
    'FC lifecycle hook `onAttributeChanged` is no longer part of the v0.2 core API. Move it to host-layer code instead.',
  ],
]);

/** 读取调用表达式名称，兼容 `foo()` 与 `ns.foo()`。 */
export const getCallExpressionName = (
  expression: ts.Expression
): string | null => {
  if (ts.isIdentifier(expression)) {
    return expression.text;
  }

  if (ts.isPropertyAccessExpression(expression)) {
    return expression.name.text;
  }

  return null;
};

// 在真正进入编译流水线前提前拦截已移除生命周期，避免后续阶段才以模糊错误失败。
export const validateFunctionLifecycleHookUsage = (
  functionDeclaration: FunctionComponentLike,
  sourceFile: ts.SourceFile
): void => {
  if (!functionDeclaration.body || !ts.isBlock(functionDeclaration.body)) {
    return;
  }

  for (const statement of functionDeclaration.body.statements) {
    if (
      !ts.isExpressionStatement(statement) ||
      !ts.isCallExpression(statement.expression)
    ) {
      continue;
    }

    const calleeName = getCallExpressionName(statement.expression.expression);
    if (!calleeName || !REMOVED_FUNCTION_LIFECYCLE_HOOKS.has(calleeName)) {
      continue;
    }

    const message =
      REMOVED_FUNCTION_LIFECYCLE_HOOK_MESSAGES.get(calleeName) ??
      `Unsupported FC lifecycle hook \`${calleeName}\`.`;
    const lineAndCharacter = sourceFile.getLineAndCharacterOfPosition(
      statement.expression.expression.getStart(sourceFile)
    );

    throw new Error(
      `${message} (${sourceFile.fileName}:${lineAndCharacter.line + 1}:${lineAndCharacter.character + 1})`
    );
  }
};

const isUppercaseComponentName = (name: string | undefined): name is string => {
  return typeof name === 'string' && /^[A-Z]/.test(name);
};

// 兼容 `defineComponent(() => ...)` 包装写法，把真实函数体抽取出来继续按 FC 处理。
const getDefineComponentCallback = (
  expression: ts.Expression
): FunctionComponentLike | null => {
  if (
    !ts.isCallExpression(expression) ||
    getCallExpressionName(expression.expression) !== 'defineComponent'
  ) {
    return null;
  }

  const callback = expression.arguments[0];
  if (!callback) {
    return null;
  }

  if (ts.isFunctionExpression(callback) || ts.isArrowFunction(callback)) {
    return callback;
  }

  return null;
};

const getDefineComponentOptions = (
  expression: ts.Expression
): ts.ObjectLiteralExpression | undefined => {
  if (
    !ts.isCallExpression(expression) ||
    getCallExpressionName(expression.expression) !== 'defineComponent'
  ) {
    return undefined;
  }
  const options = expression.arguments[1];
  return options && ts.isObjectLiteralExpression(options) ? options : undefined;
};

// 只有首字母大写的函数才被视为组件入口，避免把普通工具函数误识别成组件。
const resolveFunctionComponentName = (
  declaration: FunctionComponentLike,
  fallbackName?: string
): string | null => {
  if (
    (ts.isFunctionDeclaration(declaration) ||
      ts.isFunctionExpression(declaration)) &&
    declaration.name &&
    isUppercaseComponentName(declaration.name.text)
  ) {
    return declaration.name.text;
  }

  return isUppercaseComponentName(fallbackName) ? fallbackName : null;
};

// 入口解析按“函数声明 -> 变量 defineComponent -> export default defineComponent”顺序探测。
/**
 * 收集文件里所有组件声明。
 *
 * 多组件文件是合法写法（子组件与默认导出组件同文件），因此这里返回全部候选，
 * 再由 `findFunctionComponent()` 选出编译入口：默认导出优先，否则取第一个。
 */
export const findFunctionComponents = (
  sourceFile: ts.SourceFile
): ResolvedFunctionComponent[] => {
  const components: ResolvedFunctionComponent[] = [];
  // `export default Foo` 指向的标识符，等扫描结束后再回填到对应声明上。
  let defaultExportName: string | null = null;

  for (const statement of sourceFile.statements) {
    // 先找最直接的函数声明入口，保证常规写法有最稳定的识别优先级。
    if (
      ts.isFunctionDeclaration(statement) &&
      statement.name !== undefined &&
      isUppercaseComponentName(statement.name.text)
    ) {
      components.push({
        name: statement.name.text,
        declaration: statement,
        isDefaultExport: hasDefaultModifier(statement),
      });
      continue;
    }

    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name) || !declaration.initializer) {
          continue;
        }

        const callback = getDefineComponentCallback(declaration.initializer);
        const componentName = callback
          ? resolveFunctionComponentName(callback, declaration.name.text)
          : null;

        if (callback && componentName) {
          // 变量声明模式下仍返回真实回调体，后续阶段无需关心外层 defineComponent 包装。
          components.push({
            name: componentName,
            declaration: callback,
            options: getDefineComponentOptions(declaration.initializer),
          });
        }
      }
      continue;
    }

    if (ts.isExportAssignment(statement)) {
      if (ts.isIdentifier(statement.expression)) {
        defaultExportName = statement.expression.text;
        continue;
      }

      // `export default defineComponent(...)` 没有额外变量名时，只能依赖回调自身命名。
      const callback = getDefineComponentCallback(statement.expression);
      const componentName = callback
        ? resolveFunctionComponentName(callback)
        : null;

      if (callback && componentName) {
        components.push({
          name: componentName,
          declaration: callback,
          options: getDefineComponentOptions(statement.expression),
          isDefaultExport: true,
        });
      }
    }
  }

  if (defaultExportName) {
    const target = components.find(
      (candidate) => candidate.name === defaultExportName
    );

    if (target) {
      target.isDefaultExport = true;
    }
  }

  return components;
};

const hasDefaultModifier = (statement: ts.Statement): boolean => {
  return Boolean(
    ts.canHaveModifiers(statement) &&
    ts
      .getModifiers(statement)
      ?.some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword)
  );
};

/** 选定编译入口：`export default` 的组件优先，否则取文件里的第一个组件。 */
export const findFunctionComponent = (
  sourceFile: ts.SourceFile
): ResolvedFunctionComponent | undefined => {
  const components = findFunctionComponents(sourceFile);
  return (
    components.find((component) => component.isDefaultExport) ?? components[0]
  );
};

/** 从单表达式箭头函数或单 return 体中提取表达式文本。 */
export const getSingleArrowExpression = (
  expression: ts.Expression | undefined,
  sourceFile: ts.SourceFile
): string | null => {
  if (!expression || !ts.isArrowFunction(expression)) {
    return null;
  }

  if (ts.isBlock(expression.body)) {
    if (
      expression.body.statements.length !== 1 ||
      !ts.isReturnStatement(expression.body.statements[0]) ||
      !expression.body.statements[0].expression
    ) {
      return null;
    }

    return expression.body.statements[0].expression.getText(sourceFile);
  }

  return expression.body.getText(sourceFile);
};

export const getFunctionLikeParamsText = (
  callback: ts.ArrowFunction | ts.FunctionExpression,
  sourceFile: ts.SourceFile
): string => {
  return callback.parameters
    .map((parameter) => parameter.getText(sourceFile))
    .join(', ');
};

export const getFunctionLikeBodyText = (
  callback: ts.ArrowFunction | ts.FunctionExpression,
  sourceFile: ts.SourceFile
): string | null => {
  if (ts.isBlock(callback.body)) {
    return callback.body.statements
      .map((statement) => statement.getText(sourceFile))
      .join('\n');
  }

  return callback.body.getText(sourceFile);
};

// props 与 context 别名采集会作为后续“绑定重写”的输入，因此这里尽量保持静态保守。
/**
 * 将 TS 类型字面量简化成运行时 property 类型枚举。
 *
 * 这里的目标不是精确还原 TypeScript 类型系统，而是为运行时 property 元数据提供
 * 足够稳定的粗粒度类别。
 */
const propertyTypeFromTypeNode = (
  typeNode: ts.TypeNode | undefined
): 'String' | 'Number' | 'Boolean' | 'Object' => {
  if (!typeNode) {
    return 'Object';
  }

  if (ts.isParenthesizedTypeNode(typeNode)) {
    return propertyTypeFromTypeNode(typeNode.type);
  }

  if (ts.isUnionTypeNode(typeNode)) {
    const candidates = typeNode.types.filter(
      (candidate) => candidate.kind !== ts.SyntaxKind.UndefinedKeyword
    );
    return propertyTypeFromTypeNode(candidates[0]);
  }

  switch (typeNode.kind) {
    case ts.SyntaxKind.StringKeyword:
      return 'String';
    case ts.SyntaxKind.NumberKeyword:
      return 'Number';
    case ts.SyntaxKind.BooleanKeyword:
      return 'Boolean';
    default:
      return 'Object';
  }
};

const collectPropsFromMembers = (
  members: ts.NodeArray<ts.TypeElement>
): SignalDeclaration[] => {
  return members.flatMap((member) => {
    if (!member.name || !ts.isIdentifier(member.name)) {
      return [];
    }

    if (ts.isPropertySignature(member)) {
      return [
        {
          type: 'SignalDeclaration' as const,
          name: member.name.text,
          signalKind: 'property' as const,
          initializer: null,
          propertyType: propertyTypeFromTypeNode(member.type),
        },
      ];
    }

    if (ts.isMethodSignature(member)) {
      // 回调型 props 也按 Object 处理，保证它们能被写成实例字段并保持更新。
      return [
        {
          type: 'SignalDeclaration' as const,
          name: member.name.text,
          signalKind: 'property' as const,
          initializer: null,
          propertyType: 'Object' as const,
        },
      ];
    }

    return [];
  });
};

const collectPropsFromInterface = (
  iface: ts.InterfaceDeclaration,
  sourceFile: ts.SourceFile,
  seen: Set<string>
): SignalDeclaration[] => {
  const inherited = (iface.heritageClauses ?? []).flatMap((clause) => {
    if (clause.token !== ts.SyntaxKind.ExtendsKeyword) {
      return [];
    }

    return clause.types.flatMap((type) => {
      if (
        !ts.isExpressionWithTypeArguments(type) ||
        !ts.isIdentifier(type.expression)
      ) {
        return [];
      }

      return resolvePropsTypeName(type.expression.text, sourceFile, seen);
    });
  });

  return [...inherited, ...collectPropsFromMembers(iface.members)];
};

const resolvePropsTypeName = (
  name: string,
  sourceFile: ts.SourceFile,
  seen: Set<string>
): SignalDeclaration[] => {
  // 同一名字在不同文件里含义不同，seen 需要带上文件维度。
  const key = `${sourceFile.fileName}::${name}`;

  if (seen.has(key)) {
    return [];
  }

  seen.add(key);

  const alias = sourceFile.statements.find(
    (statement): statement is ts.TypeAliasDeclaration =>
      ts.isTypeAliasDeclaration(statement) && statement.name.text === name
  );

  if (alias) {
    return collectPropsFromTypeNode(alias.type, sourceFile, seen);
  }

  const iface = sourceFile.statements.find(
    (statement): statement is ts.InterfaceDeclaration =>
      ts.isInterfaceDeclaration(statement) && statement.name.text === name
  );

  if (iface) {
    return collectPropsFromInterface(iface, sourceFile, seen);
  }

  // 同文件找不到时，按相对路径读取被导入的类型声明再展开。
  const imported = resolveImportedTypeDeclaration(name, sourceFile);

  if (!imported) {
    return [];
  }

  if (ts.isTypeAliasDeclaration(imported.declaration)) {
    return collectPropsFromTypeNode(
      imported.declaration.type,
      imported.sourceFile,
      seen
    );
  }

  return collectPropsFromInterface(
    imported.declaration,
    imported.sourceFile,
    seen
  );
};

const collectPropsFromTypeNode = (
  typeNode: ts.TypeNode | undefined,
  sourceFile: ts.SourceFile,
  seen: Set<string>
): SignalDeclaration[] => {
  if (!typeNode) {
    return [];
  }

  if (ts.isTypeLiteralNode(typeNode)) {
    return collectPropsFromMembers(typeNode.members);
  }

  if (ts.isParenthesizedTypeNode(typeNode)) {
    return collectPropsFromTypeNode(typeNode.type, sourceFile, seen);
  }

  if (ts.isIntersectionTypeNode(typeNode)) {
    return typeNode.types.flatMap((entry) =>
      collectPropsFromTypeNode(entry, sourceFile, seen)
    );
  }

  if (ts.isTypeReferenceNode(typeNode) && ts.isIdentifier(typeNode.typeName)) {
    return resolvePropsTypeName(typeNode.typeName.text, sourceFile, seen);
  }

  return [];
};

/**
 * 从首参中提取 props 声明，并保留 props 变量别名。
 *
 * 支持同文件内的 `type Props = {...}`、`interface Props {...}` 以及它们的
 * 交叉/继承形态；跨文件导入的类型暂时无法在单文件编译器中静态展开。
 */
export const collectFunctionProps = (
  functionDeclaration: FunctionComponentLike,
  sourceFile: ts.SourceFile
): {
  props: SignalDeclaration[];
  propAlias: string | null;
} => {
  const parameter = functionDeclaration.parameters[0];

  if (!parameter || !ts.isIdentifier(parameter.name)) {
    return {
      props: [],
      propAlias: null,
    };
  }

  const collected = collectPropsFromTypeNode(
    parameter.type,
    sourceFile,
    new Set()
  );
  // 交叉类型或继承可能重复声明同一个 prop，这里按名字去重并保留最先出现的类型。
  const deduped = new Map<string, SignalDeclaration>();

  collected.forEach((prop) => {
    if (!deduped.has(prop.name)) {
      deduped.set(prop.name, prop);
    }
  });

  return {
    props: [...deduped.values()],
    propAlias: parameter.name.text,
  };
};

/** 收集 context 中 `emit` 的可访问别名。 */
export const collectContextEmitAliases = (
  functionDeclaration: FunctionComponentLike
): Set<string> => {
  const aliases = new Set<string>();
  // 第二个参数约定为上下文对象；这里只提取其中可用于派发事件的 emit 别名。
  const parameter = functionDeclaration.parameters[1];

  if (!parameter) {
    return aliases;
  }

  if (ts.isObjectBindingPattern(parameter.name)) {
    parameter.name.elements.forEach((element) => {
      if (
        ts.isBindingElement(element) &&
        element.propertyName &&
        ts.isIdentifier(element.propertyName) &&
        element.propertyName.text === 'emit' &&
        ts.isIdentifier(element.name)
      ) {
        aliases.add(element.name.text);
      }

      if (
        ts.isBindingElement(element) &&
        !element.propertyName &&
        ts.isIdentifier(element.name) &&
        element.name.text === 'emit'
      ) {
        aliases.add(element.name.text);
      }
    });
  }

  if (ts.isIdentifier(parameter.name)) {
    aliases.add(`${parameter.name.text}.emit`);
  }

  return aliases;
};

/** 找到函数组件第一个带表达式的 return，并解析其中 JSX。 */
export const parseFunctionReturnTemplate = (
  sourceFile: ts.SourceFile,
  functionDeclaration: FunctionComponentLike
) => {
  if (!functionDeclaration.body) {
    throw new Error('Function component body was not found.');
  }

  if (!ts.isBlock(functionDeclaration.body)) {
    // 表达式体箭头函数可直接视为“隐式 return JSX”。
    return parseReturnedJsxTemplate(sourceFile, functionDeclaration.body);
  }

  const returnStatement = functionDeclaration.body.statements.find(
    (statement): statement is ts.ReturnStatement =>
      ts.isReturnStatement(statement) && statement.expression !== undefined
  );

  if (!returnStatement?.expression) {
    throw new Error('Function component must return a JSX tree.');
  }

  // 块体函数只消费首个带表达式的 return；更复杂控制流留给后续能力再扩展。
  return parseReturnedJsxTemplate(sourceFile, returnStatement.expression);
};
