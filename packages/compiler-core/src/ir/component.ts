/**
 * 组件 IR 总出口。
 *
 * `compiler-core` 的大部分后续阶段都围绕 `ComponentIR` 工作，
 * 因此这里提供一个稳定的聚合入口，屏蔽 `ir/component/*` 下的内部拆分细节。
 * 上层可以通过这一层拿到 lowering、helper、类型与代码生成所需定义。
 */
export * from './component/index';
