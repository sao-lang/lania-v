/**
 * 运行时调度器。
 *
 * 为什么需要它：
 * - 把“信号变更 / 生命周期 / 副作用 / 过渡任务”统一排队，避免同步级联导致的抖动；
 * - 按优先级分桶（immediate/high/normal/low/idle），并在微任务中批量 flush；
 * - `UnitOfWork` 用 MessageChannel 分片执行，提供近似 time-slicing 的过渡能力。
 *
 * 可以把它理解成 runtime 的“任务中枢”：
 * 普通信号更新、组件生命周期、副作用和 transition work 都从这里进入，
 * 但会被分发到不同队列，以获得更稳定的时序与更低的阻塞风险。
 *
 * 关键时序约束也在这里收口：
 * - 普通 job 先于 lifecycle/effect；
 * - flush 期间新增任务不会插入当前快照中途，而是进入下一轮消费；
 * - `tick()` 等待的是一次“稳定 flush”结束，而不只是当前队列瞬时为空。
 */
import { emitSchedulerDebugEvent, isDevEnvironment } from '../core/debug';

export type Job = () => void;
export type SchedulerPriority = 'immediate' | 'high' | 'normal' | 'low' | 'idle';
export type JobPriority = SchedulerPriority;

export const IMMEDIATE: SchedulerPriority = 'immediate';
export const HIGH: SchedulerPriority = 'high';
export const NORMAL: SchedulerPriority = 'normal';
export const LOW: SchedulerPriority = 'low';
export const IDLE: SchedulerPriority = 'idle';

export interface UnitOfWork {
  /**
   * 返回 `false` 表示未完成，本轮保留在队首，下次继续执行；
   * 其他返回值表示完成，会被 shift 出队列。
   */
  run: () => boolean | void;
}

export interface DoubleBufferState<T> {
  current: T;
  pending: T;
  update: (recipe: (current: T) => T) => T;
  commit: () => T;
}

export const supportsRequestIdleCallback = (): boolean => {
  return typeof globalThis.requestIdleCallback === 'function';
};

// `startTransition` 只需要影响同步写入阶段的 signal 调度优先级。
// 用模块级覆盖而不是改每个 Signal，能让现有编译产物完全无感知。
let signalPriorityOverride: SchedulerPriority | null = null;

export const getSignalPriority = (): SchedulerPriority => {
  return signalPriorityOverride ?? NORMAL;
};

export const withSignalPriority = <T>(
  priority: SchedulerPriority,
  run: () => T
): T => {
  const previous = signalPriorityOverride;
  signalPriorityOverride = priority;

  try {
    return run();
  } finally {
    signalPriorityOverride = previous;
  }
};

const PRIORITY_ORDER: SchedulerPriority[] = [
  IMMEDIATE,
  HIGH,
  NORMAL,
  LOW,
  IDLE,
];

export class Scheduler {
  // 普通 job 队列（按优先级分桶）
  private readonly queue = new Map<SchedulerPriority, Set<Job>>(
    PRIORITY_ORDER.map((priority) => [priority, new Set<Job>()])
  );
  // 生命周期 job（组件更新类任务）
  private readonly lifecycleQueue = new Set<Job>();
  // effect job（watch/effect 等）
  private readonly effectQueue = new Set<Job>();
  // time-slicing 任务队列（transition 等）
  private readonly unitQueue = new Map<SchedulerPriority, UnitOfWork[]>(
    PRIORITY_ORDER.map((priority) => [priority, []])
  );
  private scheduled = false;
  private isFlushing = false;
  private batchDepth = 0;
  private channel: MessageChannel | null = null;
  private unitScheduled = false;
  private readonly timeSliceMs = 5;
  private readonly tickResolvers = new Set<() => void>();
  // 维护待执行 job 计数，避免每次 size/hasQueuedJobs 都展开所有队列。
  private pendingJobs = 0;

  schedule(job: Job, priority: SchedulerPriority = NORMAL): void {
    const bucket = this.queue.get(priority);

    if (bucket) {
      const sizeBefore = bucket.size;
      bucket.add(job);

      if (bucket.size !== sizeBefore) {
        this.pendingJobs += 1;
      }
    }

    if (isDevEnvironment()) {
      emitSchedulerDebugEvent({
        type: 'schedule',
        priority,
        queueSize: this.pendingJobs,
      });
    }

    this.ensureScheduled();
  }

  scheduleSignal(job: Job, priority: SchedulerPriority = NORMAL): void {
    this.schedule(job, priority);
  }

  scheduleLifecycle(job: Job, priority: SchedulerPriority = HIGH): void {
    // lifecycle 单独排队，避免和普通 signal job 混在同一个优先级桶里。
    const sizeBefore = this.lifecycleQueue.size;
    this.lifecycleQueue.add(job);

    if (this.lifecycleQueue.size !== sizeBefore) {
      this.pendingJobs += 1;
    }

    if (isDevEnvironment()) {
      emitSchedulerDebugEvent({
        type: 'schedule-lifecycle',
        priority,
        queueSize: this.pendingJobs,
      });
    }

    this.ensureScheduled();
  }

  scheduleEffect(job: Job, _priority: SchedulerPriority = LOW): void {
    // effect 当前统一落到 effectQueue，内部时序固定在 signal/lifecycle 之后。
    const sizeBefore = this.effectQueue.size;
    this.effectQueue.add(job);

    if (this.effectQueue.size !== sizeBefore) {
      this.pendingJobs += 1;
    }

    if (isDevEnvironment()) {
      emitSchedulerDebugEvent({
        type: 'schedule-effect',
        priority: LOW,
        queueSize: this.pendingJobs,
      });
    }

    this.ensureScheduled();
  }

  scheduleUnitOfWork(
    work: UnitOfWork,
    priority: SchedulerPriority = NORMAL
  ): void {
    this.unitQueue.get(priority)?.push(work);

    if (isDevEnvironment()) {
      emitSchedulerDebugEvent({
        type: 'schedule-unit',
        priority,
      });
    }

    this.ensureUnitScheduled();
  }

  flush(): void {
    if (this.isFlushing) {
      return;
    }

    this.scheduled = false;
    this.isFlushing = true;

    if (isDevEnvironment()) {
      emitSchedulerDebugEvent({
        type: 'flush-start',
        queueSize: this.pendingJobs,
      });
    }

    try {
      while (this.hasQueuedJobs()) {
        // 先跑普通优先级队列，再跑生命周期与 effect（确保 signal 先落地，再更新视图/副作用）
        // 若这些回调在执行期间继续 schedule 新任务，新任务会留在队列中，
        // 由 while 循环在下一轮继续消费，而不是插回当前快照中途打乱顺序。
        for (const priority of PRIORITY_ORDER) {
          const priorityQueue = this.queue.get(priority);

          if (!priorityQueue || priorityQueue.size === 0) {
            continue;
          }

          const jobs = [...priorityQueue];
          priorityQueue.clear();
          this.pendingJobs -= jobs.length;

          for (const job of jobs) {
            job();
          }
        }

        if (this.lifecycleQueue.size > 0) {
          // 生命周期队列整体快照后再执行，避免执行期间新增任务打乱当前轮次。
          // 因而生命周期里再次触发的 schedule，最早也会在同一次 flush 的下一轮落地。
          const lifecycleJobs = [...this.lifecycleQueue];
          this.lifecycleQueue.clear();
          this.pendingJobs -= lifecycleJobs.length;

          for (const job of lifecycleJobs) {
            job();
          }
        }

        if (this.effectQueue.size > 0) {
          // effect 永远压在当前轮普通提交之后，尽量观察到稳定后的状态。
          // 这让 effect 更接近“提交完成后的订阅回调”，而不是参与本轮状态收敛本身。
          const effectJobs = [...this.effectQueue];
          this.effectQueue.clear();
          this.pendingJobs -= effectJobs.length;

          for (const job of effectJobs) {
            job();
          }
        }
      }
    } finally {
      this.isFlushing = false;

      if (isDevEnvironment()) {
        emitSchedulerDebugEvent({
          type: 'flush-end',
          queueSize: this.pendingJobs,
        });
      }

      this.ensureScheduled();
      this.resolveTicksIfIdle();
    }
  }

  batch<T>(fn: () => T): T {
    this.batchDepth += 1;

    try {
      return fn();
    } finally {
      this.batchDepth -= 1;
      // batch 出栈时再统一尝试调度，可把批内多次 schedule 合并进一个微任务。
      this.ensureScheduled();
    }
  }

  get size(): number {
    return this.pendingJobs;
  }

  createTransition<T>(work: () => T): Promise<T> {
    // transition 通过 unit-of-work 运行，避免一次性大任务阻塞 UI
    return new Promise<T>((resolve) => {
      this.scheduleUnitOfWork(
        {
          run: () => {
            resolve(this.batch(work));
            return true;
          },
        },
        LOW
      );
    });
  }

  createDoubleBufferState<T>(initialValue: T): DoubleBufferState<T> {
    let current = initialValue;
    let pending = initialValue;

    return {
      get current() {
        return current;
      },
      get pending() {
        return pending;
      },
      update(recipe) {
        // 连续 update 基于 pending 叠加，适合在一个过渡阶段暂存多次变更。
        pending = recipe(pending);
        return pending;
      },
      commit() {
        current = pending;
        return current;
      },
    };
  }

  scheduleIdle(work: () => void): void {
    if (supportsRequestIdleCallback()) {
      globalThis.requestIdleCallback?.(() => work());
      return;
    }

    this.schedule(work, IDLE);
  }

  tick(): Promise<void> {
    return new Promise<void>((resolve) => {
      this.tickResolvers.add(resolve);

      if (!this.isFlushing && !this.hasQueuedJobs()) {
        // 即使当前为空，也延后一拍再检查一次，让同一调用栈内后续 schedule 的任务
        // 有机会并入这次 tick 等待的 flush。
        // 因此 tick() 语义更接近“等待当前调用栈发起的下一次稳定 flush”，而不是立刻 resolve。
        queueMicrotask(() => this.resolveTicksIfIdle());
        return;
      }

      this.ensureScheduled();
    });
  }

  private hasQueuedJobs(): boolean {
    return this.pendingJobs > 0;
  }

  private ensureScheduled(): void {
    if (
      this.batchDepth > 0 ||
      this.scheduled ||
      this.isFlushing ||
      !this.hasQueuedJobs()
    ) {
      return;
    }

    this.scheduled = true;
    // 在微任务中批量 flush，同步多次 schedule 会自动合并
    queueMicrotask(() => this.flush());
  }

  private resolveTicksIfIdle(): void {
    if (this.isFlushing || this.hasQueuedJobs() || this.tickResolvers.size === 0) {
      return;
    }

    const resolvers = [...this.tickResolvers];
    this.tickResolvers.clear();

    for (const resolve of resolvers) {
      resolve();
    }
  }

  private ensureUnitScheduled(): void {
    if (this.unitScheduled || !this.hasUnitOfWork()) {
      return;
    }

    this.unitScheduled = true;
    const channel = this.getChannel();
    // 用 MessageChannel 触发下一轮分片执行，避免长任务一直卡在单个微任务中。
    channel.port2.postMessage(undefined);
  }

  private hasUnitOfWork(): boolean {
    return [...this.unitQueue.values()].some((workItems) => workItems.length > 0);
  }

  private getChannel(): MessageChannel {
    if (!this.channel) {
      this.channel = new MessageChannel();
      this.channel.port1.onmessage = () => {
        this.unitScheduled = false;
        this.flushUnitOfWork();
      };
    }

    return this.channel;
  }

  private flushUnitOfWork(): void {
    const startTime = Date.now();

    for (const priority of PRIORITY_ORDER) {
      const queue = this.unitQueue.get(priority);

      if (!queue || queue.length === 0) {
        continue;
      }

      while (queue.length > 0) {
        const work = queue[0];

        if (isDevEnvironment()) {
          emitSchedulerDebugEvent({
            type: 'unit-run',
            priority,
          });
        }

        const completed = work.run();

        if (completed !== false) {
          // 只有明确返回 false 才视为“未完成”，保留在队首等待下一片继续。
          queue.shift();
        }

        if (Date.now() - startTime >= this.timeSliceMs) {
          // 超出时间片：下次 message 继续执行
          this.ensureUnitScheduled();
          return;
        }
      }
    }

    if (this.hasUnitOfWork()) {
      this.ensureUnitScheduled();
      return;
    }

    this.disposeChannel();
  }

  private disposeChannel(): void {
    if (!this.channel) {
      return;
    }

    this.channel.port1.onmessage = null;
    this.channel.port1.close();
    this.channel.port2.close();
    this.channel = null;
  }
}

export const defaultScheduler = new Scheduler();

export const schedule = (job: Job): void => {
  defaultScheduler.schedule(job);
};

export const scheduleSignal = (
  job: Job,
  priority: SchedulerPriority = NORMAL
): void => {
  defaultScheduler.scheduleSignal(job, priority);
};

export const scheduleLifecycle = (
  job: Job,
  priority: SchedulerPriority = HIGH
): void => {
  defaultScheduler.scheduleLifecycle(job, priority);
};

export const scheduleEffect = (job: Job): void => {
  defaultScheduler.scheduleEffect(job);
};

export const batch = <T>(fn: () => T): T => {
  return defaultScheduler.batch(fn);
};

export const createDoubleBufferState = <T>(initialValue: T): DoubleBufferState<T> => {
  return defaultScheduler.createDoubleBufferState(initialValue);
};

export const scheduleIdle = (work: () => void): void => {
  defaultScheduler.scheduleIdle(work);
};

export const tick = (): Promise<void> => {
  return defaultScheduler.tick();
};
