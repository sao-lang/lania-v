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
  collectFunctionFormValue,
  collectFunctionLifecycleCallbacks,
  collectFunctionLifecycleHooks,
  collectFunctionSetupBindings,
  collectFunctionSignals,
} from './collectors';
import {
  collectContextEmitAliases,
  collectFunctionProps,
  findFunctionComponent,
  getCallExpressionName,
  parseFunctionReturnTemplate,
  validateFunctionLifecycleHookUsage,
} from './helpers';
import type { ParsedTsxFunctionComponent, FunctionBindingContext } from './types';

/** 解析函数组件源码，并生成 compiler-core 所需的组件声明。 */
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
  const functionComponent = findFunctionComponent(sourceFile);
  const functionDeclaration = functionComponent?.declaration;

  if (!functionDeclaration?.name) {
    throw new Error('Function component declaration was not found.');
  }

  validateFunctionLifecycleHookUsage(functionDeclaration, sourceFile);

  // 先采集原始声明，再统一用同一套 binding context 重写，避免多次重复扫描 AST。
  const functionProps = collectFunctionProps(functionDeclaration);
  const rawSignals = collectFunctionSignals(functionDeclaration, sourceFile);
  const rawComputed = collectFunctionComputed(functionDeclaration, sourceFile);
  const rawSetupBindings = collectFunctionSetupBindings(functionDeclaration, sourceFile);
  const emitAliases = collectContextEmitAliases(functionDeclaration);
  // 这里汇总所有可重写的名称，供表达式和模板重写阶段复用。
  const bindings: FunctionBindingContext = {
    propAlias: functionProps.propAlias,
    propNames: new Set(functionProps.props.map((prop) => prop.name)),
    signalNames: new Set(rawSignals.map((signal) => signal.name)),
    signalSetterToName: new Map(),
    computedNames: new Set(rawComputed.map((computed) => computed.name)),
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
  const setupBindings = rawSetupBindings.map((binding) => ({
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

  // 解析阶段在这里收束为统一组件声明，后续 compiler-core 不再关心它最初是否来自函数组件。
  const formValueExpression = collectFunctionFormValue(functionDeclaration, sourceFile);
  const rewrittenFormValue =
    formValueExpression === null
      ? null
      : rewriteExpressionWithBindings(formValueExpression, bindings);

  const component: ComponentDeclaration = {
    type: 'ComponentDeclaration',
    name: functionComponent?.name ?? 'AnonymousComponent',
    componentKind: 'function',
    signals,
    computed,
    effects:
      rewrittenFormValue === null
        ? effects
        : [
            ...effects,
            {
              // `useFormValue` 复用 effect 通道：依赖收集、调度与清理都与 createEffect 一致。
              type: 'EffectDeclaration',
              name: '__formValue',
              body: `this._setFormValue(${rewrittenFormValue});`,
            },
          ],
    lifecycleHooks: collectFunctionLifecycleHooks(functionDeclaration),
    lifecycleCallbacks,
    setupBindings,
    formAssociated: rewrittenFormValue !== null,
    template: rewriteFunctionTemplateNode(
      // 模板内表达式必须使用与 setup/effect 相同的访问模型，否则后续 IR 会前后不一致。
      parseFunctionReturnTemplate(sourceFile, functionDeclaration, mode),
      bindings
    ),
  };

  return {
    sourceFile,
    component,
    program: {
      type: 'Program',
      fileName,
      sourceKind: 'tsx-function-component',
      body: [component],
    },
  };
};

export type { ParsedTsxFunctionComponent } from './types';
