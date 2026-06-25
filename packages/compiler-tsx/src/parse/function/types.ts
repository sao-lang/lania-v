/**
 * 函数组件解析阶段的共享类型。
 *
 * 这一层不承载具体解析逻辑，而是为“函数组件入口解析”与“表达式绑定重写”提供
 * 统一的数据契约，主要解决两类信息传递：
 * 1. 某个 `.lania.tsx` 文件被识别成组件后，后续阶段最少需要携带哪些编译产物；
 * 2. 在重写模板/表达式引用时，哪些名字属于 props、signal、computed、emit 或本地绑定。
 *
 * 把这些结构集中放在独立文件里有两个目的：
 * - 让 `parse/function/*` 下多个步骤共享同一组上下文定义，避免对象形状漂移；
 * - 让后续分析与编译阶段只依赖类型契约，而不直接耦合解析实现细节。
 */
import ts from 'typescript';

import type {
  CompilerProgram,
  ComponentDeclaration,
} from '@lania-v/compiler-core';

export interface ParsedTsxFunctionComponent {
  // 原始 TS SourceFile，供后续 AST 遍历、定位和源码文本读取使用。
  sourceFile: ts.SourceFile;
  // 编译器 Program 保留下来，后续绑定分析和类型辅助都可能继续访问。
  program: CompilerProgram;
  // 识别出的组件声明节点，是后续模板抽取与代码生成的核心入口。
  component: ComponentDeclaration;
}

/** 表达式重写时使用的名称绑定上下文。 */
export interface FunctionBindingContext {
  // props 若被整体起了别名（如 `function Comp(props)`），这里记录别名。
  propAlias: string | null;
  // 直接从 props 解构出来的字段名集合。
  propNames: Set<string>;
  // signal 读函数名集合，用于区分普通函数调用和响应式读取。
  signalNames: Set<string>;
  // signal setter 到 signal 名的映射，便于把 `setCount()` 反推回 `count`。
  signalSetterToName: Map<string, string>;
  // computed/memo 之类衍生值名称集合。
  computedNames: Set<string>;
  // 当前函数作用域里声明的局部绑定，避免误判成组件输入或运行时 helper。
  localBindingNames: Set<string>;
  // `emit` 可能被重命名或解构，因此用集合统一记录可识别别名。
  emitAliases: Set<string>;
}
