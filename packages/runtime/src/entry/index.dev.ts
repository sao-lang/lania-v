import { setDevEnvironmentOverride } from '../core/debug';

// dev 构建：强制开启 debug hooks（不依赖打包器注入的 __DEV__）。
setDevEnvironmentOverride(true);

export * from '../index';
