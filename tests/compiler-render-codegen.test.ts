import { describe, expect, it } from 'vitest';

import { generateClassComponentCode, generateRenderCode } from '@lania-v/compiler-core';
import { generateRenderCode as generateRenderCodeInternal } from '../packages/compiler-core/src/codegen/render';

describe('compiler render codegen', () => {
  it('generates a _renderAndMount method with hoisted static template and text slots', () => {
    const result = generateRenderCode({
      className: 'CounterElement',
      staticHtml: '<section><h1>Static title</h1><p>Count: <span>0</span></p></section>',
      textBindings: [
        {
          slotIndex: 0,
          path: [0, 1, 1, 0],
          expression: 'this.count()',
        },
      ],
    });

    expect(result.hoistName).toBe('__CounterElement_staticTemplate');
    expect(result.code).toContain(
      "const __CounterElement_staticTemplate = createStaticTemplate("
    );
    expect(result.method).toContain('protected _renderAndMount(): void {');
    expect(result.method).toContain(
      'const mounted = mountStaticTemplate(this.renderRoot, __CounterElement_staticTemplate, { hydrate: true });'
    );
    expect(result.method).toContain(
      'const slot0Node = resolveTextSlotNode(mounted, 0, [0, 1, 1, 0]);'
    );
    expect(result.method).toContain(
      'const slot0 = this.registerSlot(new TextSlot(slot0Node, 0));'
    );
    expect(result.method).toContain('this._slots[0] = slot0.node;');
    expect(result.method).toContain('const restoreHydrationSignalUpdaters = () => {');
    expect(result.method).toContain('applyInitialBindings();');
  });

  it('generates a class component wrapper around render code and updater methods', () => {
    const result = generateClassComponentCode({
      type: 'ComponentIR',
      name: 'CounterElement',
      sourceKind: 'tsx-class-component',
      props: [],
      signals: [{ name: 'count', initializer: 'createSignal(0)' }],
      computed: [{ name: 'double', expression: 'this.count() * 2' }],
      effects: [{ name: 'syncLog', body: 'console.log(this.count());' }],
      lifecycle: {
        connected: false,
        disconnected: false,
        adopted: false,
        attributeChanged: false,
        willUpdate: false,
        updated: false,
        firstUpdated: false,
      },
      lifecycleCallbacks: [],
      setupBindings: [],
      template: {
        type: 'TemplateIR',
        roots: [
          {
            type: 'ElementIR',
            tagName: 'section',
            path: [0],
            staticAttributes: {},
            dynamicAttributes: [],
            events: [],
            directives: [],
            children: [
              {
                type: 'ExpressionIR',
                path: [0, 0],
                slotIndex: 0,
                expression: 'this.count()',
              },
            ],
          },
        ],
        slotCount: 1,
      },
      renderPlan: {
        staticHtml: '<section>__LANIA_SLOT_0__</section>',
        textBindings: [
          {
            slotIndex: 0,
            path: [0, 0],
            expression: 'this.count()',
          },
        ],
        listBindings: [],
        conditionBindings: [],
        dynamicBindings: [],
        boundaryBindings: [],
        teleportBindings: [],
        runtimeUpdaters: [
          {
            name: 'updateSlot0',
            kind: 'single-slot',
            slotIndices: [0],
            dependencies: ['count'],
            expression: 'this.count()',
          },
        ],
        signalBindingMap: {
          count: 'this.count',
        },
      },
      optimizationPass: {
        staticDomHoisted: true,
        constantFoldedExpressions: [],
        expressionMerges: [],
        slotPackingMap: { 0: 0 },
        inlinedComputed: [],
      },
      dependencyAnalysis: {
        entries: [
          {
            source: 'text',
            expression: 'this.count()',
            updater: 'updateSlot0',
            signalDependencies: [
              {
                kind: 'this-signal-call',
                name: 'count',
                text: 'this.count()',
                accessPath: [],
              },
            ],
            slotIndex: 0,
            path: [0, 0],
          },
          {
            source: 'computed',
            expression: 'this.count() * 2',
            updater: 'updateComputed_double',
            signalDependencies: [
              {
                kind: 'this-signal-call',
                name: 'count',
                text: 'this.count()',
                accessPath: [],
              },
            ],
          },
          {
            source: 'effect',
            expression: 'console.log(this.count());',
            updater: 'runEffect_syncLog',
            signalDependencies: [
              {
                kind: 'this-signal-call',
                name: 'count',
                text: 'this.count()',
                accessPath: [],
              },
            ],
          },
        ],
        signalToSlotMap: { count: [0] },
        signalToUpdaterMap: {
          count: ['runEffect_syncLog', 'updateComputed_double', 'updateSlot0'],
        },
        computedDependencyChain: { double: ['count'] },
        effectDependencyChain: { syncLog: ['count'] },
        deepPathReads: {},
      },
      slotAllocation: {
        slots: [
          {
            slotIndex: 0,
            type: 'text',
            path: [0, 0],
            expression: 'this.count()',
            updater: 'updateSlot0',
          },
        ],
        totalSlots: 1,
      },
      updaterGeneration: {
        updaters: [
          {
            name: 'updateSlot0',
            kind: 'single-slot',
            source: 'slot',
            phase: 'update',
            slotIndices: [0],
            dependencies: ['count'],
            expression: 'this.count()',
          },
          {
            name: 'updateComputed_double',
            kind: 'computed',
            source: 'computed',
            phase: 'update',
            slotIndices: [],
            dependencies: ['count'],
            expression: 'this.count() * 2',
          },
          {
            name: 'runEffect_syncLog',
            kind: 'effect',
            source: 'effect',
            phase: 'effect',
            slotIndices: [],
            dependencies: ['count'],
            expression: 'console.log(this.count());',
          },
        ],
        singleSlotUpdaterNames: ['updateSlot0'],
        multiSlotUpdaterNames: [],
        computedUpdaterNames: ['updateComputed_double'],
        effectUpdaterNames: ['runEffect_syncLog'],
      },
    });

    expect(result.code).toContain('class CounterElement extends ReactiveElement {');
    expect(result.code).toContain('static render(ctx: Record<string, unknown> = {}): string {');
    expect(result.code).toContain('protected _renderAndMount(): void {');
    expect(result.code).toContain('protected updateSlot0(): void {');
    expect(result.code).toContain('void (this.count());');
    expect(result.code).toContain('protected updateComputed_double(): void {');
    expect(result.code).toContain('void (this.count() * 2);');
    expect(result.code).toContain('protected runEffect_syncLog(): void {');
    expect(result.code).toContain('console.log(this.count());');
    expect(result.ssrCode.code).toContain(
      'ssrRenderTextSlot(0, ssrEvaluate("this.count()", __lania_ssr_ctx))'
    );
  });

  it('generates DynamicSlot and TeleportSlot bindings for enhanced component render plans', () => {
    const result = generateRenderCode({
      className: 'EnhancedRenderElement',
      staticHtml: '<section><!--__LANIA_SLOT_0__--><!--__LANIA_SLOT_1__--></section>',
      textBindings: [],
      dynamicBindings: [
        {
          slotIndex: 0,
          path: [0, 0],
          componentExpression: 'this.resolveTag()',
          propsExpression: '{ "title": this.title() }',
          templateHtml: '<span>Body</span>',
          hoistName: '__dynamic_slot_0_0_0',
        },
      ],
      teleportBindings: [
        {
          slotIndex: 1,
          path: [0, 1],
          targetExpression: 'this.portal()',
          templateHtml: '<strong>Portal</strong>',
          hoistName: '__teleport_slot_0_1_1',
        },
      ],
    });

    expect(result.code).toContain(
      'const __dynamic_slot_0_0_0 = createStaticTemplate("<span>Body</span>");'
    );
    expect(result.code).toContain(
      'const __dynamic_slot_0_0_0_factory = () => [...__dynamic_slot_0_0_0.clone().childNodes];'
    );
    expect(result.code).toContain(
      'const __teleport_slot_0_1_1 = createStaticTemplate("<strong>Portal</strong>");'
    );
    expect(result.code).toContain(
      'const __teleport_slot_0_1_1_factory = () => [...__teleport_slot_0_1_1.clone().childNodes];'
    );
    expect(result.method).toContain(
      'const slot0 = this.registerSlot(new DynamicSlot(slot0Node, __dynamic_slot_0_0_0, 0));'
    );
    expect(result.method).toContain(
      'slot0.write({ __lania_dynamic: "block", component: this.resolveTag(), props: { "title": this.title() }, childBindings: [] });'
    );
    expect(result.method).toContain(
      'const slot1 = this.registerSlot(new TeleportSlot(slot1Node, __teleport_slot_0_1_1, 1));'
    );
    expect(result.method).toContain(
      'slot1.write({ __lania_teleport: "block", target: this.portal(), bindings: [] });'
    );
  });

  it('emits boundary block slots through source-level render codegen', () => {
    const result = generateRenderCodeInternal({
      className: 'SuspenseElement',
      staticHtml: '<!--__LANIA_SLOT_0__-->',
      textBindings: [],
      componentBindings: [],
      listBindings: [],
      conditionBindings: [],
      dynamicBindings: [],
      boundaryBindings: [
        {
          slotIndex: 0,
          path: [0],
          componentName: 'Suspense',
          templateHtml: '<section>ready</section>',
          hoistName: '__boundary_slot_root_0',
          payloadExpression:
            '{"protocol":"@lania/enhanced-contract","version":"0.1.0","payloadKind":"boundary","component":"Suspense","irKind":"BoundaryIR","boundaryIndex":0,"initialState":"idle","childrenTemplate":{},"fallbackTemplate":{},"metadata":{"suspenseKey":"hero"}}',
          fallbackTemplateHtml: '<span>loading</span>',
          fallbackHoistName: '__boundary_fallback_slot_root_0',
          children: [],
        },
      ],
      keepAliveBindings: [],
      teleportBindings: [],
      runtimeUpdaters: [],
      signalBindingMap: {},
      storeBindingMap: {},
      propBindingMap: {},
    });

    expect(result.code).toContain('new BoundarySlot(');
    expect(result.code).toContain('__lania_boundary: "block"');
    expect(result.code).toContain('"payloadKind":"boundary"');
    expect(result.code).toContain('"component":"Suspense"');
    expect(result.code).toContain('slot0.hydrate(readHydrationSlotNodes(mounted, 0), { __lania_boundary: "block"');
  });

  it('passes boundary bindings through class component codegen', () => {
    const result = generateClassComponentCode({
      type: 'ComponentIR',
      name: 'BoundaryWrapperElement',
      sourceKind: 'tsx-class-component',
      props: [],
      signals: [],
      computed: [],
      effects: [],
      lifecycle: {
        connected: false,
        disconnected: false,
        adopted: false,
        attributeChanged: false,
        willUpdate: false,
        updated: false,
        firstUpdated: false,
      },
      lifecycleCallbacks: [],
      setupBindings: [],
      template: {
        type: 'TemplateIR',
        roots: [],
        slotCount: 1,
      },
      renderPlan: {
        staticHtml: '<!--__LANIA_SLOT_0__-->',
        textBindings: [],
        componentBindings: [],
        listBindings: [],
        conditionBindings: [],
        dynamicBindings: [],
        boundaryBindings: [
          {
            slotIndex: 0,
            path: [0],
            componentName: 'Suspense',
            templateHtml: '<section>ready</section>',
            hoistName: '__boundary_slot_root_0',
            payloadExpression:
              '{"protocol":"@lania/enhanced-contract","version":"0.1.0","payloadKind":"boundary","component":"Suspense","irKind":"BoundaryIR","boundaryIndex":0,"initialState":"idle","childrenTemplate":{},"fallbackTemplate":{},"metadata":{"suspenseKey":"hero"}}',
            fallbackTemplateHtml: '<span>loading</span>',
            fallbackHoistName: '__boundary_fallback_slot_root_0',
            children: [],
          },
        ],
        keepAliveBindings: [],
        teleportBindings: [],
        runtimeUpdaters: [],
        signalBindingMap: {},
        storeBindingMap: {},
      },
      optimizationPass: {
        staticDomHoisted: true,
        constantFoldedExpressions: [],
        expressionMerges: [],
        slotPackingMap: { 0: 0 },
        inlinedComputed: [],
      },
      dependencyAnalysis: {
        entries: [],
        signalToSlotMap: {},
        signalToUpdaterMap: {},
        computedDependencyChain: {},
        effectDependencyChain: {},
        deepPathReads: {},
      },
      slotAllocation: {
        slots: [],
        totalSlots: 0,
      },
      updaterGeneration: {
        updaters: [],
        singleSlotUpdaterNames: [],
        multiSlotUpdaterNames: [],
        computedUpdaterNames: [],
        effectUpdaterNames: [],
      },
    });

    expect(result.code).toContain('new BoundarySlot(');
    expect(result.code).toContain('__lania_boundary: "block"');
  });
});
