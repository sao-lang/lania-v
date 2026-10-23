/**
 * 响应式核心的内部追踪入口。
 *
 * `trackSignals` / `linkTrackedSignals` / `isTracking` 是编译器产物与 updater
 * 依赖发现机制使用的底层能力，不属于普通业务 API，因此不进入根入口。
 */
export {
  isTracking,
  linkTrackedSignals,
  trackSignals,
  type Signal,
} from './signal';
