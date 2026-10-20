/**
 * 函数组件 TSX 解析入口。
 *
 * 这里负责把“函数式书写方式”的组件源码整理成 compiler-core 能直接消费的
 * `ComponentDeclaration`：
 * 1. 识别 props、signal、computed、effect、生命周期与 setup 绑定；
 * 2. 建立名称映射表，统一重写表达式中的访问方式；
 * 3. 把返回的 JSX 模板转换为模板 AST，并同步完成绑定重写。
 */
import ts from 'typescript';

import {
  parseTypeScriptSource,
  type ComponentDeclaration,
  type EffectDeclaration,
} from '@lania-v/compiler-core';
import {
  assertNoLegacyTsxDirectiveSyntax,
  preprocessTsxBindingSyntax,
} from '../../syntax/tsx-binding';
import type { TsxTemplateSyntaxMode } from '../template-mode';

import { rewriteBlockWithBindings, rewriteExpressionWithBindings, rewriteFunctionTemplateNode } from './bindings';
import {
  collectFunctionComputed,
  collectFunctionEffects,
  collectFunctionFormValidity,
  collectFunctionFormValue,
  collectFunctionLifecycleCallbacks,
  collectFunctionLifecycleHooks,
  collectFunctionPropDestructuring,
  collectFunctionRefNames,
  collectFunctionSetupBindings,
  collectFunctionSignals,
} from './collectors';
import {
  collectContextEmitAliases,
  collectFunctionProps,
  findFunctionComponents,
  getCallExpressionName,
  parseFunctionReturnTemplate,
  validateFunctionLifecycleHookUsage,
  type ResolvedFunctionComponent,
} from './helpers';
import { collectFunctionComponentOptions } from './options';
import type { ParsedTsxFunctionComponent, FunctionBindingContext } from './types';

/**
 * 把一个组件声明解析成 compiler-core 的 `ComponentDeclaration`。
 *
 * 采集、重写与模板抽取都只依赖“当前组件 + 同一个 SourceFile”，
 * 因此单个文件里的多个组件可以各自独立走一遍这段流程。
 */
const createComponentDeclaration = (
  sourceFile: ts.SourceFile,
  functionComponent: ResolvedFunctionComponent,
  mode: TsxTemplateSyntaxMode
): ComponentDeclaration => {
  const functionDeclaration = functionComponent.declaration;

  if (!functionDeclaration.name) {
    throw new Error('Function component declaration was not found.');
  }

  validateFunctionLifecycleHookUsage(functionDeclaration, sourceFile);

  // 先采集原始声明，再统一用同一套 binding context 重写，避免多次重复扫描 AST。
  const functionProps = collectFunctionProps(functionDeclaration, sourceFile);
  const componentOptions = collectFunctionComponentOptions(
    functionComponent?.options,
    functionProps.props,
    sourceFile
  );
  const rawSignals = collectFunctionSignals(functionDeclaration, sourceFile);
  const rawComputed = collectFunctionComputed(functionDeclaration, sourceFile);
  const refNames = collectFunctionRefNames(functionDeclaration, sourceFile);
  const rawSetupBindings = collectFunctionSetupBindings(
    functionDeclaration,
    sourceFile,
    functionProps.propAlias
  );
  const destructuredProps = collectFunctionPropDestructuring(
    functionDeclaration,
    functionProps.propAlias,
    functionProps.props.map((prop) => prop.name),
    sourceFile
  );
  const propAliases = destructuredProps.aliases;
  const declaredPropNames = new Set(functionProps.props.map((prop) => prop.name));

  if (propAliases.size > 0 && declaredPropNames.size === 0) {
    // 解构必须映射到真实的 prop 字段；无法展开类型时继续映射会得到 `this.xxx = undefined`。
    throw new Error(
      'Cannot statically resolve the props type for destructuring. Use an inline object type or declare the props type/interface in the same .lania.tsx file.'
    );
  }

  // 类型能静态展开时，顺手拦住拼错的 prop 名。
  if (declaredPropNames.size > 0) {
    for (const [localName, propName] of propAliases) {
      if (!declaredPropNames.has(propName)) {
        throw new Error(
          `Unknown prop "${propName}" in destructuring \`const { ${localName} } = ${functionProps.propAlias}\`.`
        );
      }
    }
  }

  const emitAliases = collectContextEmitAliases(functionDeclaration);
  // 这里汇总所有可重写的名称，供表达式和模板重写阶段复用。
  const bindings: FunctionBindingContext = {
    propAlias: functionProps.propAlias,
    propNames: new Set(functionProps.props.map((prop) => prop.name)),
    propAliases,
    propReplacements: destructuredProps.replacements,
    signalNames: new Set(rawSignals.map((signal) => signal.name)),
    signalSetterToName: new Map(),
    computedNames: new Set(rawComputed.map((computed) => computed.name)),
    refNames,
    localBindingNames: new Set(rawSetupBindings.map((binding) => binding.name)),
    emitAliases,
  };

  if (functionDeclaration.body && ts.isBlock(functionDeclaration.body)) {
    functionDeclaration.body.statements.forEach((statement) => {
      if (!ts.isVariableStatement(statement)) {
        return;
      }

      statement.declarationList.declarations.forEach((declaration) => {
        const calleeName =
          declaration.initializer && ts.isCallExpression(declaration.initializer)
            ? getCallExpressionName(declaration.initializer.expression)
            : null;

        if (
          calleeName !== 'createSignal' ||
          !ts.isArrayBindingPattern(declaration.name)
        ) {
          return;
        }

        const [firstElement, secondElement] = declaration.name.elements;

        if (
          firstElement &&
          secondElement &&
          ts.isBindingElement(firstElement) &&
          ts.isBindingElement(secondElement) &&
          ts.isIdentifier(firstElement.name) &&
          ts.isIdentifier(secondElement.name)
        ) {
          // `const [count, setCount] = createSignal()` 需要把 setter 反查回 signal 名。
          bindings.signalSetterToName.set(secondElement.name.text, firstElement.name.text);
        }
      });
    });
  }

  // 采集完成后统一重写表达式，保证后续 IR 只看到一致的访问模型。
  // props 也被收敛成 signal 声明，后续代码生成即可统一走实例字段访问模型。
  const signals = [...functionProps.props, ...rawSignals].map((signal) => ({
    ...signal,
    initializer:
      signal.initializer === null
        ? null
        : rewriteExpressionWithBindings(signal.initializer, bindings),
  }));
  const computed = rawComputed.map((entry) => ({
    ...entry,
    expression:
      entry.expression === null
        ? null
        : rewriteExpressionWithBindings(entry.expression, bindings),
  }));
  const effects = collectFunctionEffects(functionDeclaration, sourceFile).map((effect) => ({
    ...effect,
    body:
      effect.body === null
        ? null
        : rewriteBlockWithBindings(effect.body, bindings),
  }));
  const lifecycleCallbacks = collectFunctionLifecycleCallbacks(
    functionDeclaration,
    sourceFile
  ).map((callback) => ({
    ...callback,
    body:
      callback.body === null
        ? null
        : rewriteBlockWithBindings(callback.body, bindings),
  }));
  const rewrittenSetupBindings = rawSetupBindings.map((binding) => ({
    ...binding,
    body:
      binding.body === null
        ? null
        : rewriteBlockWithBindings(binding.body, bindings),
    initializer:
      binding.initializer === null
        ? null
        : rewriteExpressionWithBindings(binding.initializer, bindings),
  }));

  // 组件字段初始化发生在构造期，此时宿主还没机会逐项写 props。
  // 这里注入一个最靠前的 `props` 字段，承接构造期注入的 props 快照，
  // 让 `createExpose(props, ...)` 这类整体引用在编译产物里仍然可用。
  const setupBindings = functionProps.propAlias
    ? [
        {
          type: 'SetupBindingDeclaration' as const,
          name: 'props',
          kind: 'field' as const,
          params: '',
          body: null,
          initializer: `createComponentPropsSnapshot(this, ${JSON.stringify(
            functionProps.props.map((prop) => prop.name)
          )})`,
          order: -1,
        },
        ...rewrittenSetupBindings,
      ]
    : rewrittenSetupBindings;

  // 解析阶段在这里收束为统一组件声明，后续 compiler-core 不再关心它最初是否来自函数组件。
  const formValueExpression = collectFunctionFormValue(functionDeclaration, sourceFile);
  const rewrittenFormValue =
    formValueExpression === null
      ? null
      : rewriteExpressionWithBindings(formValueExpression, bindings);
  const formValidityExpression = collectFunctionFormValidity(
    functionDeclaration,
    sourceFile
  );
  const rewrittenFormValidity =
    formValidityExpression === null
      ? null
      : rewriteExpressionWithBindings(formValidityExpression, bindings);

  const formEffects: EffectDeclaration[] = [];

  if (rewrittenFormValue !== null) {
    formEffects.push({
      // `useFormValue` 复用 effect 通道：依赖收集、调度与清理都与 createEffect 一致。
      type: 'EffectDeclaration',
      name: '__formValue',
      body: `this._setFormValue(${rewrittenFormValue});`,
    });
  }

  if (rewrittenFormValidity !== null) {
    formEffects.push({
      type: 'EffectDeclaration',
      name: '__formValidity',
      body: `this._setFormValidity(${rewrittenFormValidity});`,
    });
  }

  const component: ComponentDeclaration = {
    type: 'ComponentDeclaration',
    name: functionComponent.name ?? 'AnonymousComponent',
    componentKind: 'function',
    signals,
    computed,
    effects: [...effects, ...formEffects],
    lifecycleHooks: collectFunctionLifecycleHooks(functionDeclaration),
    lifecycleCallbacks,
    setupBindings,
    formAssociated: rewrittenFormValue !== null || rewrittenFormValidity !== null,
    optionsSource: componentOptions.source ?? undefined,
    template: rewriteFunctionTemplateNode(
      // 模板内表达式必须使用与 setup/effect 相同的访问模型，否则后续 IR 会前后不一致。
      parseFunctionReturnTemplate(sourceFile, functionDeclaration, mode),
      bindings
    ),
  };

  return component;
};

/**
 * 解析函数组件源码，并生成 compiler-core 所需的组件声明。
 *
 * 同一个文件允许声明多个组件：全部组件都会进入 `Program.body`，
 * 其中 `export default` 指定的那个作为编译入口（`component`）。
 */
export const parseFunctionComponentTsx = (
  fileName: string,
  source: string,
  mode: TsxTemplateSyntaxMode = 'jsx-standard'
): ParsedTsxFunctionComponent => {
  if (mode === 'jsx-standard') {
    assertNoLegacyTsxDirectiveSyntax(fileName, source);
  }

  // 先预处理扩展绑定语法，再交给 TypeScript 构建 AST。
  const sourceFile = parseTypeScriptSource(
    fileName,
    mode === 'directive-extended' ? preprocessTsxBindingSyntax(fileName, source) : source
  );
  const functionComponents = findFunctionComponents(sourceFile);
  const entryIndex = Math.max(
    0,
    functionComponents.findIndex((component) => component.isDefaultExport)
  );
  const entry = functionComponents[entryIndex];

  if (!entry) {
    throw new Error('Function component declaration was not found.');
  }

  const declarations = functionComponents.map((component) =>
    createComponentDeclaration(sourceFile, component, mode)
  );

  return {
    sourceFile,
    component: declarations[entryIndex]!,
    components: declarations,
    program: {
      type: 'Program',
      fileName,
      sourceKind: 'tsx-function-component',
      body: declarations,
    },
  };
};

export type { ParsedTsxFunctionComponent } from './types';
