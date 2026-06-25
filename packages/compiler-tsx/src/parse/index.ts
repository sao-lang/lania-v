/**
 * TSX 解析阶段的公共导出入口。
 *
 * `parse` 目录负责把原始 `.lania.tsx` 源码拆成编译器可以继续消费的结构化结果：
 * 1. 函数组件入口解析，把源码整理为 `ComponentDeclaration`；
 * 2. JSX 模板解析，把返回的 JSX 转成模板节点树；
 * 3. 模板语法模式定义，用于区分标准 JSX 与扩展指令兼容模式。
 *
 * 这里统一聚合这些能力，便于编译主流程以单一入口接入解析子系统。
 */
// 编译入口只需依赖 parse 门面，不需要感知内部实现文件。
export * from './function';
export * from './template';
export * from './template-mode';
