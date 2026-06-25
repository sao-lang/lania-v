export type BenchItem = {
  id: number;
  label: string;
  done: boolean;
};

export const BENCH_LIST_SIZE = 1000;
export const BENCH_MIDDLE_ROW_INDEX = 500;
export const BENCH_MIDDLE_ROW_ID = BENCH_MIDDLE_ROW_INDEX + 1;

const createBenchItem = (id: number): BenchItem => ({
  id,
  label: `Item ${id}`,
  done: false,
});

export const buildBenchItems = (): BenchItem[] => {
  return Array.from({ length: BENCH_LIST_SIZE }, (_, index) => createBenchItem(index + 1));
};

export const patchBenchItems = (items: readonly BenchItem[], nextVersion: number): BenchItem[] => {
  return items.map((item) => {
    if (item.id !== BENCH_MIDDLE_ROW_ID) {
      return item;
    }

    return {
      id: item.id,
      label: `Item ${item.id} v${nextVersion}`,
      done: nextVersion % 2 === 1,
    };
  });
};

export const describeBenchItem = (item: BenchItem | null | undefined): string => {
  if (!item) {
    return 'missing';
  }

  return `${item.label}|${item.done ? '1' : '0'}`;
};
