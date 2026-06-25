/**
 * 优化阶段总出口。
 *
 * 这里统一转发模板优化、render-plan 优化以及 updater 优化能力。
 * 保留这一层别名入口的意义在于：即使内部目录继续细分，
 * 外部引用路径仍然可以稳定保持在 `transform/optimization`。
 */
export * from './optimization/index';
