/**
 * 函数组件静态信息采集器。
 *
 * 这个模块负责把函数组件源码里“后续编译阶段真正关心的声明”提前分门别类提取出来，
 * 让上层解析流程不需要在同一处同时理解响应式工厂、生命周期、setup 语句与模板返回。
 * 这里的目标不是做语义改写，而是先把零散源码折叠成几组稳定的编译输入。
 *
 * 当前主要采集几类信息：
 * 1. signal / computed / context 等可读响应式来源；
 * 2. effect 与生命周期调用及其回调体；
 * 3. 其余需要提升到组件实例上的 setup 绑定和独立语句；
 * 4. 生命周期 hook 的使用情况，供后续生成期做能力开关与代码拼装。
 *
 * 设计上这里尽量只做“静态归类”和“源码文本提取”，不做引用重写；
 * 真正的 `this.xxx` 改写由 `bindings.ts` 在后一步统一完成，以保证采集与重写职责分离。
 */
import ts from 'typescript';

import type {
  ComputedDeclaration,
  EffectDeclaration,
  LifecycleCallbackDeclaration,
  SetupBindingDeclaration,
  SignalDeclaration,
} from '@lania-v/compiler-core';
import {
  COMPUTED_FACTORIES,
  EFFECT_FACTORIES,
  FUNCTION_LIFECYCLE_HOOK_ALIASES,
  FUNCTION_LIFECYCLE_HOOKS,
  REF_FACTORIES,
  REMOVED_FUNCTION_LIFECYCLE_HOOKS,
  SIGNAL_FACTORIES,
  type FunctionComponentLike,
  getCallExpressionName,
  getFunctionLikeBodyText,
  getFunctionLikeParamsText,
  getSingleArrowExpression,
  printer,
} from './helpers';

/**
 * 把“语句序号 + 语句内声明序号”压成一个可比较的顺序值。
 *
 * signal 与 setup 字段在 IR 中被拆进两个数组，代码生成阶段需要靠这个顺序
 * 还原它们在组件体里的真实先后，否则会出现“先读后赋值”。
 */
const createDeclarationOrder = (statementIndex: number, declarationIndex = 0): number =>
  statementIndex * 100 + declarationIndex;

/**
 * 收集 `const { title, count: total } = props` 这类 props 解构别名。
 *
 * 解构本身不会被提升成组件字段，而是让后续绑定重写把本地名字直接映射到
 * `this.<prop>`。这样既保留源码写法，也不会引入一次性快照导致失去响应性。
 *
 * 支持三种常见形态：
 * - 别名：`count: total`；
 * - 默认值：`title = 'x'`（就近优先于 prop 选项的 `default`）；
 * - 嵌套：`user: { name }`（只在 `user` 整体替换时更新）；
 * - rest：`...rest`（生成剩余 prop 的 getter 视图，保持响应性）。
 */
export interface PropDestructuringResult {
  /** 本地名 -> 顶层 prop 名；用于校验与兼容旧逻辑。 */
  aliases: Map<string, string>;
  /** 本地名 -> 可直接打印的读取表达式。 */
  replacements: Map<string, string>;
}

export const collectFunctionPropDestructuring = (
  functionDeclaration: FunctionComponentLike,
  propsAlias: string | null,
  declaredPropNames: readonly string[] = [],
  sourceFile?: ts.SourceFile
): PropDestructuringResult => {
  const aliases = new Map<string, string>();
  const replacements = new Map<string, string>();

  if (!propsAlias || !functionDeclaration.body || !ts.isBlock(functionDeclaration.body)) {
    return { aliases, replacements };
  }

  const printExpression = (node: ts.Node): string =>
    sourceFile ? printer.printNode(ts.EmitHint.Unspecified, node, sourceFile) : node.getText();

  const readPropertyKey = (name: ts.PropertyName): string => {
    if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNoSubstitutionTemplateLiteral(name)) {
      return name.text;
    }
    throw new Error('Computed property names are not supported when destructuring props.');
  };

  const collectPattern = (
    pattern: ts.ObjectBindingPattern,
    path: readonly string[],
    topProp: string
  ): void => {
    pattern.elements.forEach((element) => {
      if (ts.isOmittedExpression(element)) {
        return;
      }

      if (element.dotDotDotToken) {
        throw new Error(
          'Rest elements must be at the top level when destructuring props.'
        );
      }

      const key = element.propertyName
        ? readPropertyKey(element.propertyName)
        : ts.isIdentifier(element.name)
          ? element.name.text
          : null;

      if (key === null) {
        throw new Error(
          'Nested destructuring must use identifier property names when destructuring props.'
        );
      }

      const nextPath = [...path, key];

      if (ts.isIdentifier(element.name)) {
        // `this.user?.name`：顶层是 prop getter，后续层按可选链下钻。
        const access = nextPath.reduce(
          (accumulator, segment, index) =>
            index === 0 ? `this.${segment}` : `${accumulator}?.${segment}`,
          ''
        );
        const expression = element.initializer
          ? `(${access} ?? ${printExpression(element.initializer)})`
          : access;

        aliases.set(element.name.text, topProp);
        replacements.set(element.name.text, expression);
        return;
      }

      if (ts.isObjectBindingPattern(element.name)) {
        collectPattern(element.name, nextPath, topProp);
        return;
      }

      throw new Error(
        'Nested destructuring only supports identifiers or object patterns when destructuring props.'
      );
    });
  };

  functionDeclaration.body.statements.forEach((statement) => {
    if (!ts.isVariableStatement(statement)) {
      return;
    }

    statement.declarationList.declarations.forEach((declaration) => {
      if (!ts.isObjectBindingPattern(declaration.name)) {
        return;
      }

      if (
        !declaration.initializer ||
        !ts.isIdentifier(declaration.initializer) ||
        declaration.initializer.text !== propsAlias
      ) {
        return;
      }

      const consumed = new Set<string>();

      declaration.name.elements.forEach((element) => {
        if (ts.isOmittedExpression(element)) {
          return;
        }

        if (element.dotDotDotToken) {
          if (!ts.isIdentifier(element.name)) {
            throw new Error('Rest elements must be identifiers when destructuring props.');
          }

          const remaining = declaredPropNames.filter((name) => !consumed.has(name));
          // getter 的 `this` 指向对象本身，因此把实例作为参数传进去。
          replacements.set(
            element.name.text,
            `((__laniaSelf: any) => ({ ${remaining
              .map((name) => `get ${name}() { return __laniaSelf.${name}; }`)
              .join(', ')} }))(this)`
          );
          return;
        }

        const topProp = element.propertyName
          ? readPropertyKey(element.propertyName)
          : ts.isIdentifier(element.name)
            ? element.name.text
            : null;

        if (topProp === null) {
          throw new Error(
            'Computed property names are not supported when destructuring props.'
          );
        }

        consumed.add(topProp);

        if (ts.isIdentifier(element.name)) {
          const access = `this.${topProp}`;
          const expression = element.initializer
            ? `(${access} ?? ${printExpression(element.initializer)})`
            : access;

          aliases.set(element.name.text, topProp);
          replacements.set(element.name.text, expression);
          return;
        }

        if (ts.isObjectBindingPattern(element.name)) {
          collectPattern(element.name, [topProp], topProp);
          return;
        }

        throw new Error(
          'Nested destructuring only supports identifiers or object patterns when destructuring props.'
        );
      });
    });
  });

  return { aliases, replacements };
};

/** 收集 `createRef()` 声明的模板引用名。 */
export const collectFunctionRefNames = (
  functionDeclaration: FunctionComponentLike,
  _sourceFile: ts.SourceFile
): Set<string> => {
  const names = new Set<string>();

  if (!functionDeclaration.body || !ts.isBlock(functionDeclaration.body)) {
    return names;
  }

  functionDeclaration.body.statements.forEach((statement) => {
    if (!ts.isVariableStatement(statement)) {
      return;
    }

    statement.declarationList.declarations.forEach((declaration) => {
      if (
        !ts.isIdentifier(declaration.name) ||
        !declaration.initializer ||
        !ts.isCallExpression(declaration.initializer)
      ) {
        return;
      }

      const calleeName = getCallExpressionName(declaration.initializer.expression);

      if (calleeName && REF_FACTORIES.has(calleeName)) {
        names.add(declaration.name.text);
      }
    });
  });

  return names;
};

/** 收集 `createSignal` 形式的响应式声明。 */
export const collectFunctionSignals = (
  functionDeclaration: FunctionComponentLike,
  sourceFile: ts.SourceFile
): SignalDeclaration[] => {
  if (!functionDeclaration.body || !ts.isBlock(functionDeclaration.body)) {
    return [];
  }

  const signals: SignalDeclaration[] = [];

  functionDeclaration.body.statements.forEach((statement, statementIndex) => {
    // signal 只从函数顶层变量声明里识别，避免把局部临时值误当成组件状态。
    if (!ts.isVariableStatement(statement)) {
      return;
    }

    statement.declarationList.declarations.forEach((declaration, declarationIndex) => {
      const calleeName = declaration.initializer
        && ts.isCallExpression(declaration.initializer)
        ? getCallExpressionName(declaration.initializer.expression)
        : null;

      let signalName: string | null = null;

      // 兼容两类常见 signal 写法：单变量和 tuple 解构。
      if (
        declaration.initializer &&
        ts.isCallExpression(declaration.initializer) &&
        calleeName &&
        SIGNAL_FACTORIES.has(calleeName)
      ) {
        if (ts.isIdentifier(declaration.name)) {
          signalName = declaration.name.text;
        } else if (ts.isArrayBindingPattern(declaration.name)) {
          const firstElement = declaration.name.elements[0];

          if (
            firstElement &&
            ts.isBindingElement(firstElement) &&
            ts.isIdentifier(firstElement.name)
          ) {
            signalName = firstElement.name.text;
          }
        }
      }

      // `useContext(ctx)` 在函数组件里也会暴露成可读取的 signal-like 来源。
      if (
        !signalName &&
        declaration.initializer &&
        ts.isCallExpression(declaration.initializer) &&
        calleeName === 'useContext' &&
        ts.isIdentifier(declaration.name)
      ) {
        signalName = declaration.name.text;
      }

      if (!signalName) {
        return;
      }

      signals.push({
        type: 'SignalDeclaration',
        name: signalName,
        signalKind: 'unknown',
        initializer: declaration.initializer?.getText(sourceFile) ?? null,
        order: createDeclarationOrder(statementIndex, declarationIndex),
      });
    });
  });

  return signals;
};

// 响应式声明采集之后，下面继续提取“需要转成派生值/副作用/生命周期”的顶层调用。
/** 收集 `computed` / `createMemo` 形式的计算属性。 */
export const collectFunctionComputed = (
  functionDeclaration: FunctionComponentLike,
  sourceFile: ts.SourceFile
): ComputedDeclaration[] => {
  if (!functionDeclaration.body || !ts.isBlock(functionDeclaration.body)) {
    return [];
  }

  const computedDeclarations: ComputedDeclaration[] = [];

  functionDeclaration.body.statements.forEach((statement) => {
    // computed 与 signal 一样，只认函数体顶层变量声明，不向嵌套作用域深入。
    if (!ts.isVariableStatement(statement)) {
      return;
    }

    statement.declarationList.declarations.forEach((declaration) => {
      const calleeName = declaration.initializer
        && ts.isCallExpression(declaration.initializer)
        ? getCallExpressionName(declaration.initializer.expression)
        : null;

      if (
        !ts.isIdentifier(declaration.name) ||
        !declaration.initializer ||
        !ts.isCallExpression(declaration.initializer) ||
        !calleeName ||
        !COMPUTED_FACTORIES.has(calleeName)
      ) {
        return;
      }

      computedDeclarations.push({
        type: 'ComputedDeclaration',
        name: declaration.name.text,
        expression: (() => {
          const callback = declaration.initializer.arguments[0];
          const inlineExpression = getSingleArrowExpression(callback, sourceFile);

          if (inlineExpression !== null) {
            // `computed(() => foo + bar)` 直接提取为表达式文本，便于后续内联生成。
            return inlineExpression;
          }

          if (callback && ts.isArrowFunction(callback) && ts.isBlock(callback.body)) {
            // 块体形式则包回一个 IIFE 字符串，既保留语义也方便后续继续重写绑定。
            const body = callback.body.statements
              .map((statement) => statement.getText(sourceFile))
              .join('\n');
            return `(() => {\n${body}\n})()`;
          }

          return null;
        })(),
      });
    });
  });

  return computedDeclarations;
};

/*
 * 说明：
 * 下面继续定义 effect、生命周期和 setup 绑定的采集逻辑。
 * 这一段保留在同一文件内，是为了让函数组件“静态声明采集”维持统一入口，
 * 避免相关规则分散到多个实现文件里。
 */

/** 收集顶层副作用调用，并为匿名 effect 生成稳定名称。 */
export const collectFunctionEffects = (
  functionDeclaration: FunctionComponentLike,
  sourceFile: ts.SourceFile
): EffectDeclaration[] => {
  if (!functionDeclaration.body || !ts.isBlock(functionDeclaration.body)) {
    return [];
  }

  const effects: EffectDeclaration[] = [];
  let effectIndex = 0;

  functionDeclaration.body.statements.forEach((statement) => {
    if (
      !ts.isExpressionStatement(statement) ||
      !ts.isCallExpression(statement.expression) ||
      !EFFECT_FACTORIES.has(getCallExpressionName(statement.expression.expression) ?? '')
    ) {
      return;
    }

    const callback = statement.expression.arguments[0];
    let body: string | null = null;

    if (callback && ts.isArrowFunction(callback)) {
      if (ts.isBlock(callback.body)) {
        // effect 块体保留原始语句文本，后面仍会走统一绑定重写。
        body = callback.body.statements
          .map((childStatement) => childStatement.getText(sourceFile))
          .join('\n');
      } else {
        body = callback.body.getText(sourceFile);
      }
    }

    effects.push({
      type: 'EffectDeclaration',
      // effect 在源码里允许匿名存在，这里补稳定序号名，方便后续 IR/生成阶段引用。
      name: `effect_${effectIndex}`,
      body,
    });
    effectIndex += 1;
  });

  return effects;
};

/** 扫描函数体里出现过的生命周期 hook。 */
export const collectFunctionLifecycleHooks = (
  functionDeclaration: FunctionComponentLike
): string[] => {
  if (!functionDeclaration.body || !ts.isBlock(functionDeclaration.body)) {
    return [];
  }

  const lifecycleHooks = new Set<string>();

  functionDeclaration.body.statements.forEach((statement) => {
    if (
      !ts.isExpressionStatement(statement) ||
      !ts.isCallExpression(statement.expression)
    ) {
      return;
    }

    const calleeName = getCallExpressionName(statement.expression.expression);
    const hookName =
      calleeName && FUNCTION_LIFECYCLE_HOOKS.has(calleeName)
        ? (FUNCTION_LIFECYCLE_HOOK_ALIASES.get(calleeName) ?? calleeName)
        : undefined;

    if (hookName) {
      // 用 Set 去重，避免同一 hook 多次调用时污染“能力是否启用”的判断结果。
      lifecycleHooks.add(hookName);
    }
  });

  return [...lifecycleHooks].sort();
};

/** 提取生命周期回调的参数与函数体文本。 */
export const collectFunctionLifecycleCallbacks = (
  functionDeclaration: FunctionComponentLike,
  sourceFile: ts.SourceFile
): LifecycleCallbackDeclaration[] => {
  if (!functionDeclaration.body || !ts.isBlock(functionDeclaration.body)) {
    return [];
  }

  const callbacks: LifecycleCallbackDeclaration[] = [];

  functionDeclaration.body.statements.forEach((statement) => {
    // 生命周期回调在这里保留参数和函数体文本，稍后还会经过一次绑定重写。
    if (
      !ts.isExpressionStatement(statement) ||
      !ts.isCallExpression(statement.expression)
    ) {
      return;
    }

    const calleeName = getCallExpressionName(statement.expression.expression);
    const hookName =
      calleeName && FUNCTION_LIFECYCLE_HOOKS.has(calleeName)
        ? (FUNCTION_LIFECYCLE_HOOK_ALIASES.get(calleeName) ?? calleeName)
        : undefined;
    const callback = statement.expression.arguments[0];

    if (
      !hookName ||
      !callback ||
      (!ts.isArrowFunction(callback) && !ts.isFunctionExpression(callback))
    ) {
      return;
    }

    callbacks.push({
      type: 'LifecycleCallbackDeclaration',
      hook: hookName,
      // 参数文本与函数体文本都原样保留，给后续绑定重写和代码生成复用。
      params: getFunctionLikeParamsText(callback, sourceFile),
      body: getFunctionLikeBodyText(callback, sourceFile),
    });
  });

  return callbacks;
};

// setup 绑定是最后一道兜底采集：凡是不属于专门通道的顶层声明，都在这里保留下来。
/** 收集 `useFormValue(() => expr)` 中声明的表单值表达式。 */
export const collectFunctionFormValue = (
  functionDeclaration: FunctionComponentLike,
  sourceFile: ts.SourceFile
): string | null => {
  if (!functionDeclaration.body || !ts.isBlock(functionDeclaration.body)) {
    return null;
  }

  let formValue: string | null = null;

  functionDeclaration.body.statements.forEach((statement) => {
    // 支持 `useFormValue(...)` 与 `const formValue = useFormValue(...)` 两种写法。
    const call =
      ts.isExpressionStatement(statement)
        ? statement.expression
        : ts.isVariableStatement(statement) && statement.declarationList.declarations.length === 1
          ? statement.declarationList.declarations[0]?.initializer
          : null;

    if (
      !call ||
      !ts.isCallExpression(call) ||
      getCallExpressionName(call.expression) !== 'useFormValue'
    ) {
      return;
    }

    // getter 只能是单表达式（或单 return）的箭头/函数表达式，保证能直接内联成 effect 体。
    const getter = call.arguments[0];
    const expression = getSingleArrowExpression(getter, sourceFile);

    if (!expression) {
      throw new Error(
        '`useFormValue` expects a single-expression getter, e.g. `useFormValue(() => account())`.'
      );
    }

    formValue = expression;
  });

  return formValue;
};

/** 收集 `useFormValidity(() => ...)` 中声明的表单校验表达式。 */
export const collectFunctionFormValidity = (
  functionDeclaration: FunctionComponentLike,
  sourceFile: ts.SourceFile
): string | null => {
  if (!functionDeclaration.body || !ts.isBlock(functionDeclaration.body)) {
    return null;
  }

  let validity: string | null = null;

  functionDeclaration.body.statements.forEach((statement) => {
    const call =
      ts.isExpressionStatement(statement)
        ? statement.expression
        : ts.isVariableStatement(statement) && statement.declarationList.declarations.length === 1
          ? statement.declarationList.declarations[0]?.initializer
          : null;

    if (
      !call ||
      !ts.isCallExpression(call) ||
      getCallExpressionName(call.expression) !== 'useFormValidity'
    ) {
      return;
    }

    const getter = call.arguments[0];
    const expression = getSingleArrowExpression(getter, sourceFile);

    if (!expression) {
      throw new Error(
        '`useFormValidity` expects a single-expression getter, e.g. `useFormValidity(() => valid())`.'
      );
    }

    validity = expression;
  });

  return validity;
};

// setup 绑定是最后一道兜底采集：凡是不属于专门通道的顶层声明，都在这里保留下来。
/** 收集除响应式工厂外，其余需要提升到组件实例上的本地绑定。 */
export const collectFunctionSetupBindings = (
  functionDeclaration: FunctionComponentLike,
  sourceFile: ts.SourceFile,
  propsAlias: string | null = null
): SetupBindingDeclaration[] => {
  if (!functionDeclaration.body || !ts.isBlock(functionDeclaration.body)) {
    return [];
  }

  const bindings: SetupBindingDeclaration[] = [];
  let statementIndex = 0;

  const readPropertyKey = (name: ts.PropertyName): string | null => {
    if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNoSubstitutionTemplateLiteral(name)) {
      return name.text;
    }

    if (ts.isNumericLiteral(name)) {
      return name.text;
    }

    return null;
  };

  functionDeclaration.body.statements.forEach((statement, sourceIndex) => {
    // setup 区域显式跳过最终 return，模板 JSX 会由专门的模板解析阶段处理。
    if (ts.isReturnStatement(statement)) {
      return;
    }

    if (ts.isFunctionDeclaration(statement) && statement.name && statement.body) {
      bindings.push({
        type: 'SetupBindingDeclaration',
        name: statement.name.text,
        kind: 'method',
        params: statement.parameters.map((parameter) => parameter.getText(sourceFile)).join(', '),
        body: statement.body.statements
          .map((childStatement) => childStatement.getText(sourceFile))
          .join('\n'),
        initializer: null,
        order: createDeclarationOrder(sourceIndex),
      });
      return;
    }

    if (!ts.isVariableStatement(statement)) {
      if (
        ts.isExpressionStatement(statement) &&
        (!ts.isCallExpression(statement.expression) || (() => {
          const calleeName = getCallExpressionName(statement.expression.expression);
          return !calleeName || (
            calleeName !== 'useFormValue' &&
            !EFFECT_FACTORIES.has(calleeName) &&
            !FUNCTION_LIFECYCLE_HOOKS.has(calleeName) &&
            !REMOVED_FUNCTION_LIFECYCLE_HOOKS.has(calleeName)
          );
        })())
      ) {
        // 顶层裸表达式语句也需要保留进 setup，后续会按顺序放回组件初始化阶段执行。
        bindings.push({
          type: 'SetupBindingDeclaration',
          name: `__setup_statement_${statementIndex}`,
          kind: 'statement',
          params: '',
          body: null,
          initializer: statement.expression.getText(sourceFile),
          order: createDeclarationOrder(sourceIndex),
        });
        statementIndex += 1;
      }

      return;
    }

    statement.declarationList.declarations.forEach((declaration, declarationIndex) => {
      const calleeName =
        declaration.initializer && ts.isCallExpression(declaration.initializer)
          ? getCallExpressionName(declaration.initializer.expression)
          : null;

      if (
        calleeName &&
        (calleeName === 'useFormValue' ||
          SIGNAL_FACTORIES.has(calleeName) ||
          COMPUTED_FACTORIES.has(calleeName) ||
          EFFECT_FACTORIES.has(calleeName) ||
          FUNCTION_LIFECYCLE_HOOKS.has(calleeName) ||
          REMOVED_FUNCTION_LIFECYCLE_HOOKS.has(calleeName))
      ) {
        // 响应式工厂、生命周期调用与表单值声明有各自专门采集通道，不再重复算进 setup field。
        return;
      }

      if (
        !declaration.initializer
      ) {
        return;
      }

      if (ts.isObjectBindingPattern(declaration.name)) {
        // `const { a, b: c } = source` 先把右值落到临时字段，再把每个绑定名映射成独立字段：
        // 右值只求值一次，模板里的裸引用也能统一提升为 `this.x`。
        if (
          propsAlias &&
          ts.isIdentifier(declaration.initializer) &&
          declaration.initializer.text === propsAlias
        ) {
          // props 解构由 collectFunctionPropDestructuring 单独处理，避免覆盖 prop 字段。
          return;
        }

        const objectFieldName = `__setup_object_${statementIndex}`;
        bindings.push({
          type: 'SetupBindingDeclaration',
          name: objectFieldName,
          kind: 'field',
          params: '',
          body: null,
          initializer: declaration.initializer.getText(sourceFile),
          order: createDeclarationOrder(sourceIndex),
        });

        let propertyOrder = 1;
        const collectObjectPattern = (
          pattern: ts.ObjectBindingPattern,
          access: string
        ): void => {
          const usedKeys: string[] = [];

          pattern.elements.forEach((element) => {
            if (ts.isOmittedExpression(element)) {
              return;
            }

            if (element.dotDotDotToken) {
              if (!ts.isIdentifier(element.name)) {
                throw new Error('Rest elements must be identifiers when destructuring in a function component.');
              }

              // rest 用同一份临时对象做一次解构剔除，保持右值只求值一次。
              const excluded = usedKeys
                .map((key, index) => `${JSON.stringify(key)}: __lania_rest_${index}`)
                .join(', ');
              const patternText = excluded.length > 0 ? `{ ${excluded}, ...rest }` : `{ ...rest }`;
              bindings.push({
                type: 'SetupBindingDeclaration',
                name: element.name.text,
                kind: 'field',
                params: '',
                body: null,
                initializer: `((__laniaSource: any) => { const ${patternText} = __laniaSource; return rest; })(${access})`,
                order: createDeclarationOrder(sourceIndex, propertyOrder),
              });
              propertyOrder += 1;
              return;
            }

            const key = element.propertyName
              ? readPropertyKey(element.propertyName)
              : ts.isIdentifier(element.name)
                ? element.name.text
                : null;

            if (key === null) {
              throw new Error('Computed property names are not supported when destructuring in a function component.');
            }

            usedKeys.push(key);

            if (ts.isIdentifier(element.name)) {
              bindings.push({
                type: 'SetupBindingDeclaration',
                name: element.name.text,
                kind: 'field',
                params: '',
                body: null,
                initializer: `${access}[${JSON.stringify(key)}]`,
                order: createDeclarationOrder(sourceIndex, propertyOrder),
              });
              propertyOrder += 1;
              return;
            }

            if (ts.isObjectBindingPattern(element.name)) {
              collectObjectPattern(element.name, `${access}[${JSON.stringify(key)}]`);
              return;
            }

            throw new Error('Only identifier or nested object patterns are supported when destructuring in a function component.');
          });
        };

        collectObjectPattern(declaration.name, objectFieldName);
        statementIndex += 1;
        return;
      }

      if (ts.isArrayBindingPattern(declaration.name)) {
        // 解构初始化先保留整组临时字段，再把各元素映射成独立字段，避免重复求值。
        const tupleFieldName = `__setup_tuple_${statementIndex}`;
        bindings.push({
          type: 'SetupBindingDeclaration',
          name: tupleFieldName,
          kind: 'field',
          params: '',
          body: null,
          initializer: declaration.initializer.getText(sourceFile),
          order: createDeclarationOrder(sourceIndex),
        });

        declaration.name.elements.forEach((element, index) => {
          if (
            !element ||
            !ts.isBindingElement(element) ||
            !ts.isIdentifier(element.name)
          ) {
            return;
          }

          // 各元素后续都经由临时 tuple 字段读取，保证解构右值只执行一次。
          bindings.push({
            type: 'SetupBindingDeclaration',
            name: element.name.text,
            kind: 'field',
            params: '',
            body: null,
            initializer: `${tupleFieldName}[${index}]`,
            order: createDeclarationOrder(sourceIndex, index + 1),
          });
        });
        statementIndex += 1;
        return;
      }

      if (!ts.isIdentifier(declaration.name)) {
        // 仅提升可稳定命名的字段；复杂对象解构目前不在 setup field 里展开。
        return;
      }

      if (calleeName && REF_FACTORIES.has(calleeName)) {
        // `createRef()` 在编译产物里就是普通实例字段：初值为 null，由模板 ref 赋值。
        bindings.push({
          type: 'SetupBindingDeclaration',
          name: declaration.name.text,
          kind: 'field',
          params: '',
          body: null,
          initializer: 'null',
          order: createDeclarationOrder(sourceIndex, declarationIndex),
        });
        return;
      }

      bindings.push({
        type: 'SetupBindingDeclaration',
        name: declaration.name.text,
        kind: 'field',
        params: '',
        body: null,
        initializer: declaration.initializer.getText(sourceFile),
        order: createDeclarationOrder(sourceIndex, declarationIndex),
      });
    });
  });

  return bindings;
};
