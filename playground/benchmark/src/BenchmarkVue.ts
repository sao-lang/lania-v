import { defineComponent, h, ref } from 'vue';

import {
  BENCH_MIDDLE_ROW_INDEX,
  buildBenchItems,
  describeBenchItem,
  patchBenchItems,
} from './benchmarkShared';

export default defineComponent({
  name: 'BenchmarkVue',
  setup() {
    const count = ref(0);
    const items = ref(buildBenchItems());
    const patchVersion = ref(0);
    const toggleVisible = ref(true);
    const draft = ref('seed');
    const middleSnapshot = ref(
      describeBenchItem(items.value[BENCH_MIDDLE_ROW_INDEX])
    );

    const increment = () => {
      count.value += 1;
    };

    const patchMiddle = () => {
      const nextVersion = patchVersion.value + 1;
      const nextItems = patchBenchItems(items.value, nextVersion);
      items.value = nextItems;
      patchVersion.value = nextVersion;
      middleSnapshot.value = describeBenchItem(
        nextItems[BENCH_MIDDLE_ROW_INDEX]
      );
    };

    const toggle = () => {
      toggleVisible.value = !toggleVisible.value;
    };

    return () =>
      h(
        'section',
        {
          class: 'bench-root',
          'data-bench-root': 'ready',
          'data-bench-ready': 'true',
        },
        [
          h('header', { class: 'bench-header' }, [
            h('h2', 'Vue benchmark'),
            h(
              'p',
              { class: 'bench-meta' },
              'list size: 1000 | middle row: 501'
            ),
          ]),
          h('div', { class: 'bench-grid' }, [
            h('div', { class: 'bench-card' }, [
              h('div', { class: 'bench-toolbar' }, [
                h(
                  'button',
                  {
                    class: 'bench-btn',
                    'data-bench-action': 'increment',
                    onClick: increment,
                  },
                  'increment'
                ),
                h(
                  'output',
                  { class: 'bench-output', 'data-bench-output': 'count' },
                  String(count.value)
                ),
              ]),
              h('p', { class: 'bench-note' }, 'state update -> text output'),
            ]),
            h('div', { class: 'bench-card' }, [
              h('div', { class: 'bench-toolbar' }, [
                h(
                  'button',
                  {
                    class: 'bench-btn',
                    'data-bench-action': 'patch',
                    onClick: patchMiddle,
                  },
                  'patch middle'
                ),
                h(
                  'output',
                  {
                    class: 'bench-output',
                    'data-bench-output': 'patch-version',
                  },
                  String(patchVersion.value)
                ),
                h(
                  'output',
                  {
                    class: 'bench-output bench-output-wide',
                    'data-bench-output': 'middle-row',
                  },
                  middleSnapshot.value
                ),
              ]),
              h(
                'ul',
                { class: 'bench-list', 'data-bench-list': 'patch' },
                items.value.map((item) =>
                  h(
                    'li',
                    {
                      key: item.id,
                      class: 'bench-list-row',
                      'data-bench-row-id': String(item.id),
                      'data-bench-row-done': item.done ? 'true' : 'false',
                    },
                    describeBenchItem(item)
                  )
                )
              ),
              h(
                'p',
                { class: 'bench-note' },
                '1000-item keyed list patch + middle row verification'
              ),
            ]),
            h('div', { class: 'bench-card' }, [
              h('div', { class: 'bench-toolbar' }, [
                h(
                  'button',
                  {
                    class: 'bench-btn',
                    'data-bench-action': 'toggle',
                    onClick: toggle,
                  },
                  'toggle panel'
                ),
                h(
                  'output',
                  {
                    class: 'bench-output',
                    'data-bench-output': 'toggle-state',
                  },
                  toggleVisible.value ? 'visible' : 'hidden'
                ),
              ]),
              toggleVisible.value
                ? h(
                    'section',
                    {
                      class: 'bench-panel',
                      'data-bench-output': 'toggle-panel',
                    },
                    [
                      h(
                        'p',
                        { class: 'bench-note' },
                        'mounted conditional subtree'
                      ),
                      h('p', { class: 'bench-meta' }, 'panel body: visible'),
                    ]
                  )
                : null,
            ]),
            h('div', { class: 'bench-card' }, [
              h('div', { class: 'bench-toolbar' }, [
                h('input', {
                  class: 'bench-input',
                  'data-bench-input': 'model',
                  placeholder: 'type benchmark payload',
                  value: draft.value,
                  onInput: (event: Event) => {
                    const target = event.target as HTMLInputElement | null;
                    draft.value = target?.value ?? '';
                  },
                }),
                h(
                  'output',
                  {
                    class: 'bench-output bench-output-wide',
                    'data-bench-output': 'draft',
                  },
                  draft.value
                ),
              ]),
              h(
                'p',
                { class: 'bench-note' },
                'input event -> reactive snapshot'
              ),
            ]),
          ]),
        ]
      );
  },
});
