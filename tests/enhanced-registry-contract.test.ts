import { describe, expect, it } from 'vitest';

import {
  createEnhancedParentRequirementErrorMessage,
  doesTransitionPayloadComponentUseSsrWrapperTag,
  getEnhancedEventBackedMetadataPropNames,
  ENHANCED_COMPONENT_NAMES,
  ENHANCED_COMPONENT_REGISTRY_LIST,
  ENHANCED_CONTRACT_PROTOCOL,
  ENHANCED_CONTRACT_VERSION,
  getEnhancedWhenBranchKind,
  getEnhancedBlockPayloadKind,
  getEnhancedComponentMetadataPropNames,
  getEnhancedComponentRegistryEntry,
  getEnhancedExecutableIrKind,
  getRequiredEnhancedParentComponentName,
  getTransitionPayloadComponentConfig,
  isBoundaryPayload,
  isEnhancedBlockPayload,
  isEnhancedComponentName,
  isEnhancedMarkerDescriptor,
  isEnhancedParentRequirementErrorMessage,
  isFlattenedEnhancedComponentName,
  isStructuralChildrenOnlyEnhancedComponentName,
  isSuspenseBoundaryComponentName,
  isTransitionPayloadComponentName,
  shouldRenderEnhancedComponentChildrenOnly,
  type BoundaryPayload,
  type EnhancedMarkerDescriptor,
} from '../packages/shared/src';

describe('enhanced registry and contract drafts', () => {
  it('defines a shared registry for the current enhanced component surface', () => {
    expect(ENHANCED_COMPONENT_NAMES).toEqual([
      'When',
      'Then',
      'Else',
      'Switch',
      'Case',
      'Default',
      'Match',
      'Each',
      'Teleport',
      'Fragment',
      'Slot',
      'Dynamic',
      'KeepAlive',
      'Transition',
      'TransitionGroup',
      'LazyLoad',
      'ErrorBoundary',
      'Suspense',
      'Await',
      'Virtual',
      'Reach',
    ]);

    expect(getEnhancedComponentRegistryEntry('Await')).toMatchObject({
      category: 'structure-lifecycle',
      irKind: 'DynamicIR',
    });
    expect(getEnhancedComponentRegistryEntry('Virtual')).toMatchObject({
      category: 'structure-lifecycle',
      irKind: 'DynamicIR',
    });

    expect(getEnhancedComponentRegistryEntry('KeepAlive')).toMatchObject({
      category: 'structure-lifecycle',
      irKind: 'KeepAliveIR',
      runtimeHostKind: 'structural',
    });
    expect(getEnhancedComponentRegistryEntry('Suspense')).toMatchObject({
      category: 'boundary',
      irKind: 'BoundaryIR',
      staticRenderMode: 'children-only',
    });
    expect(getEnhancedComponentMetadataPropNames('KeepAlive')).toContain(
      'cacheKey'
    );
    expect(isEnhancedComponentName('TransitionGroup')).toBe(true);
    expect(isEnhancedComponentName('section')).toBe(false);
    expect(isFlattenedEnhancedComponentName('Fragment')).toBe(true);
    expect(getEnhancedWhenBranchKind('Then')).toBe('truthy');
    expect(getEnhancedWhenBranchKind('Else')).toBe('fallback');
    expect(getRequiredEnhancedParentComponentName('Then')).toBe('When');
    expect(getRequiredEnhancedParentComponentName('Case')).toBe('Switch');
    expect(getRequiredEnhancedParentComponentName('Match')).toBe('Switch');
    expect(getRequiredEnhancedParentComponentName('Default')).toBe('Switch');
    expect(getEnhancedComponentMetadataPropNames('When')).toContain('value');
    expect(getEnhancedComponentMetadataPropNames('Switch')).toContain('value');
    expect(getEnhancedComponentMetadataPropNames('Each')).toContain('value');
    expect(createEnhancedParentRequirementErrorMessage('Then')).toBe(
      '<Then> can only be used as a direct child of <When>.'
    );
    expect(createEnhancedParentRequirementErrorMessage('Case')).toBe(
      '<Case> can only be used as a direct child of <Switch>.'
    );
    expect(
      isEnhancedParentRequirementErrorMessage(
        '<Then> can only be used as a direct child of <When>.'
      )
    ).toBe(true);
    expect(getEnhancedEventBackedMetadataPropNames('KeepAlive')).toEqual([
      'onActivate',
      'onDeactivate',
      'onCache',
      'onEvict',
    ]);
    expect(isStructuralChildrenOnlyEnhancedComponentName('Transition')).toBe(
      true
    );
    expect(isStructuralChildrenOnlyEnhancedComponentName('Suspense')).toBe(
      false
    );
    expect(isTransitionPayloadComponentName('TransitionGroup')).toBe(true);
    expect(isSuspenseBoundaryComponentName('Suspense')).toBe(true);
    expect(doesTransitionPayloadComponentUseSsrWrapperTag('Transition')).toBe(
      false
    );
    expect(
      doesTransitionPayloadComponentUseSsrWrapperTag('TransitionGroup')
    ).toBe(true);
    expect(
      getTransitionPayloadComponentConfig('TransitionGroup')
    ).toMatchObject({
      keyPropName: 'groupKey',
      tagPropName: 'tag',
      phases: ['appear', 'enter', 'move', 'leave'],
    });

    // Registry list should be stable and cover the same surface as the exported names.
    expect(ENHANCED_COMPONENT_REGISTRY_LIST.map((entry) => entry.name)).toEqual(
      ENHANCED_COMPONENT_NAMES
    );

    // Basic invariants: registry is the single source of truth for metadata prop names and modes.
    ENHANCED_COMPONENT_NAMES.forEach((name) => {
      const entry = getEnhancedComponentRegistryEntry(name);
      expect(entry).not.toBeNull();
      expect(entry!.name).toBe(name);
      expect(getEnhancedComponentMetadataPropNames(name)).toEqual(
        entry!.metadataPropNames
      );
      expect(isFlattenedEnhancedComponentName(name)).toBe(
        entry!.staticRenderMode === 'flatten'
      );
      expect(shouldRenderEnhancedComponentChildrenOnly(name)).toBe(
        entry!.staticRenderMode === 'children-only'
      );
    });

    // Contract mapping invariants:
    // - Any non-passthrough enhanced component must have an executable IR kind and a payload kind.
    // - Passthrough entries should not map to executable IR / payload kinds.
    ENHANCED_COMPONENT_REGISTRY_LIST.forEach((entry) => {
      const executableIrKind = getEnhancedExecutableIrKind(entry.name);
      const payloadKind = getEnhancedBlockPayloadKind(entry.name);

      if (entry.irKind === 'passthrough') {
        expect(executableIrKind).toBeNull();
        expect(payloadKind).toBeNull();
        expect(entry.staticRenderMode).toBe('flatten');
        return;
      }

      expect(executableIrKind).toBe(entry.irKind);
      expect(payloadKind).not.toBeNull();
    });
  });

  it('provides shared payload and marker guards for the draft contract layer', () => {
    const marker: EnhancedMarkerDescriptor = {
      kind: 'boundary-start',
      id: 'suspense-0:start',
      component: 'Suspense',
      path: [0, 0],
      scope: 'root',
    };

    const payload: BoundaryPayload = {
      protocol: ENHANCED_CONTRACT_PROTOCOL,
      version: ENHANCED_CONTRACT_VERSION,
      payloadKind: 'boundary',
      component: 'Suspense',
      irKind: 'TransitionIR',
      transitionIndex: 0,
      initialState: 'pending',
      childrenTemplate: {
        hoist: '__suspense_main_0',
        html: '<section>ready</section>',
      },
      fallbackTemplate: {
        hoist: '__suspense_fallback_0',
        html: '<p>loading</p>',
      },
      hydration: {
        mode: 'resume',
        markerId: marker.id,
        payloadId: 'boundary:suspense-0',
      },
      markers: [marker],
      metadata: {
        suspenseKey: 'page',
      },
    };

    expect(isEnhancedMarkerDescriptor(marker)).toBe(true);
    expect(isEnhancedBlockPayload(payload)).toBe(true);
    expect(isBoundaryPayload(payload)).toBe(true);
    expect(
      isEnhancedBlockPayload({
        protocol: ENHANCED_CONTRACT_PROTOCOL,
        version: 'broken',
        payloadKind: 'boundary',
        component: 'Suspense',
        irKind: 'TransitionIR',
      })
    ).toBe(false);
  });
});
