/**
 * TSX 模板语法模式定义。
 *
 * 当前编译器在解析 JSX/TSX 模板时支持两种入口口径：
 * 1. `jsx-standard`：只接受标准 JSX 属性语法，并主动拦截旧式指令写法；
 * 2. `directive-extended`：兼容历史扩展绑定语法，如 `model:value.trim`、`click.stop`。
 *
 * 这个类型虽然很小，但会贯穿语法预处理、模板解析和诊断阶段，
 * 因而需要单独抽出来作为跨模块共享契约。
 */
export type TsxTemplateSyntaxMode = 'jsx-standard' | 'directive-extended';
