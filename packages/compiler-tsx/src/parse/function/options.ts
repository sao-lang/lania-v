/**
 * `defineComponent(fn, options)` 的静态选项收集。
 *
 * 这里只做两件事：
 * 1. 把第二参数的**原文**带回编译产物（`static __laniaOptions = ...`），
 *    由运行时在类求值时解析，所以选项里可以写任意表达式、引用 import；
 * 2. 当选项确实是字面量时，顺手做一次廉价校验（未知 prop / 未知选项 / emits 非字符串）。
 *
 * 之所以不再把选项“拆数值再打印”，是因为那样会退化成只支持字面量：
 * `type: MyNumber`、`attribute: ATTR_NAMES.count`、`props: sharedProps` 都无法表达。
 */
import ts from 'typescript';

import type { SignalDeclaration } from '@lania-v/compiler-core';

import { printer } from './helpers';

const OPTION_KEYS = new Set(['props', 'emits']);

const readPropertyName = (node: ts.PropertyName): string | null => {
  if (
    ts.isIdentifier(node) ||
    ts.isStringLiteral(node) ||
    ts.isNoSubstitutionTemplateLiteral(node)
  ) {
    return node.text;
  }
  return null;
};

const throwOptionError = (
  sourceFile: ts.SourceFile,
  node: ts.Node,
  message: string
): never => {
  const position = sourceFile.getLineAndCharacterOfPosition(
    node.getStart(sourceFile)
  );
  throw new Error(
    `${message} (${sourceFile.fileName}:${position.line + 1}:${position.character + 1})`
  );
};

const validatePropsLiteral = (
  propsNode: ts.ObjectLiteralExpression,
  declaredProps: readonly SignalDeclaration[],
  sourceFile: ts.SourceFile
): void => {
  const declared = new Set(declaredProps.map((prop) => prop.name));

  propsNode.properties.forEach((entry) => {
    if (!ts.isPropertyAssignment(entry)) {
      // 展开 / 简写 / 方法都允许：它们由运行时求值，编译器不猜。
      return;
    }

    const name = readPropertyName(entry.name);
    if (!name) {
      return;
    }

    if (!declared.has(name)) {
      throwOptionError(
        sourceFile,
        entry.name,
        `Unknown prop "${name}" in defineComponent props options.`
      );
    }
  });
};

const validateOptionsLiteral = (
  optionsNode: ts.ObjectLiteralExpression,
  declaredProps: readonly SignalDeclaration[],
  sourceFile: ts.SourceFile
): void => {
  optionsNode.properties.forEach((property) => {
    if (!ts.isPropertyAssignment(property)) {
      // `...sharedOptions` / 简写属性交给运行时，编译器不展开。
      return;
    }

    const key = readPropertyName(property.name);

    if (key === null) {
      return;
    }

    if (!OPTION_KEYS.has(key)) {
      throwOptionError(
        sourceFile,
        property.name,
        `Unknown defineComponent option "${key}".`
      );
    }

    if (key === 'props') {
      if (ts.isObjectLiteralExpression(property.initializer)) {
        validatePropsLiteral(property.initializer, declaredProps, sourceFile);
      }
      return;
    }

    if (!ts.isArrayLiteralExpression(property.initializer)) {
      // 允许 `emits: SHARED_EVENTS` 这类表达式。
      return;
    }

    property.initializer.elements.forEach((element) => {
      if (
        !ts.isStringLiteral(element) &&
        !ts.isNoSubstitutionTemplateLiteral(element)
      ) {
        throwOptionError(
          sourceFile,
          element,
          'defineComponent `emits` entries must be string literals.'
        );
      }
    });
  });
};

export interface CollectFunctionComponentOptionsResult {
  /** 选项原文；没有第二参数时为 `null`。 */
  source: string | null;
}

export const collectFunctionComponentOptions = (
  options: ts.ObjectLiteralExpression | null | undefined,
  declaredProps: readonly SignalDeclaration[],
  sourceFile: ts.SourceFile
): CollectFunctionComponentOptionsResult => {
  if (!options) {
    return { source: null };
  }

  validateOptionsLiteral(options, declaredProps, sourceFile);

  return {
    source: printer.printNode(ts.EmitHint.Unspecified, options, sourceFile),
  };
};
