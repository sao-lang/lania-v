import { setDevEnvironmentOverride } from '../core/debug';

// prod 构建：强制关闭 debug hooks（不依赖打包器注入的 __DEV__）。
setDevEnvironmentOverride(false);

export * from '../index';
