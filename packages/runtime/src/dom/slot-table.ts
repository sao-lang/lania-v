/**
 * 组件内 slot 注册表与脏位管理。
 *
 * 编译产物会把一个模板里的动态点位拆成若干 slot，并通过 slot index 建立稳定索引。
 * `SlotTable` 则负责两件事：
 * - 保存 index -> slot 的映射，供运行时按需读取与销毁；
 * - 使用 `bigint` 脏位记录哪些 slot 需要重新提交，便于批量 flush 时做增量更新。
 *
 * 这层本身不关心具体 slot 类型，只维护“哪些位置存在、哪些位置脏了”这两个事实。
 */
import type { Slot, SlotFrequency } from './slots';

export const getSlotBit = (index: number): bigint => {
  // 一个 slot 对应一个 bit，index 越大位移越高。
  return 1n << BigInt(index);
};

export class SlotTable {
  private readonly slots = new Map<number, Slot>();
  private dirtyBits = 0n;

  register<TSlot extends Slot>(slot: TSlot): TSlot {
    this.slots.set(slot.index, slot);
    return slot;
  }

  get<TSlot extends Slot = Slot>(index: number): TSlot | undefined {
    return this.slots.get(index) as TSlot | undefined;
  }

  markDirty(index: number): void {
    this.dirtyBits |= getSlotBit(index);
  }

  markDirtySlots(indices: Iterable<number>): void {
    for (const index of indices) {
      this.markDirty(index);
    }
  }

  isDirty(index: number): boolean {
    return (this.dirtyBits & getSlotBit(index)) !== 0n;
  }

  clearDirty(index?: number): void {
    if (index === undefined) {
      // 不传 index 时表示整轮 flush 已完成，直接清空全部脏位。
      this.dirtyBits = 0n;
      return;
    }

    this.dirtyBits &= ~getSlotBit(index);
  }

  getDirtySlots(): Slot[] {
    return [...this.slots.values()]
      .filter((slot) => this.isDirty(slot.index))
      // 始终按 index 升序返回，保证提交顺序稳定、可预测。
      .sort((left, right) => left.index - right.index);
  }

  getSlotsByFrequency(frequency: SlotFrequency): Slot[] {
    return [...this.slots.values()]
      .filter((slot) => slot.frequency === frequency)
      .sort((left, right) => left.index - right.index);
  }

  destroyAll(): void {
    // 销毁顺序同样保持稳定，避免 teardown 过程因为遍历顺序不同而出现隐性差异。
    for (const slot of [...this.slots.values()].sort((left, right) => left.index - right.index)) {
      slot.destroy();
    }

    this.slots.clear();
    this.dirtyBits = 0n;
  }

  get size(): number {
    return this.slots.size;
  }

  get dirty(): bigint {
    return this.dirtyBits;
  }
}
