import { describe, expect, it } from 'vitest';
import { compose, LIMITATIONS } from '../../src/shopping/composition';
import { catalog, plan } from './fixtures';

describe('validated A2UI v0.9.1 composition', () => {
  it('hydrates authoritative facts and preserves the trusted shell and configuration', () => {
    const batch = compose(JSON.stringify(plan), catalog);
    expect(batch.catalogId).toBe(
      'https://luluspeedworks.com/catalog/scaffold/v1',
    );
    expect(batch.messages[0].version).toBe('v0.9.1');
    const components = batch.messages[0].updateComponents.components;
    expect(components.find(node => node.id === 'agent-one')).toMatchObject({
      name: 'Pit tray',
      price: '$12.50',
      href: '/products/1',
    });
    expect(components.find(node => node.id === 'focus')).toMatchObject({
      compatibility: LIMITATIONS.fit_unknown,
    });
    expect(components.map(node => node.id)).not.toEqual(
      expect.arrayContaining(['root', 'configuration', 'bag']),
    );
    expect(JSON.stringify(batch)).not.toContain('updateDataModel');
  });

  it('supports reordered browse entries and a different focus arrangement', () => {
    const result = compose(
      JSON.stringify({
        answer: 'policy_unknown',
        components: [
          {
            id: 'products',
            component: 'ProductRail',
            entries: ['agent-two', 'agent-one'],
          },
          { id: 'agent-two', component: 'ProductEntry', productId: 2 },
          { id: 'agent-one', component: 'ProductEntry', productId: 1 },
          {
            id: 'focus',
            component: 'ProductFocus',
            productId: null,
            images: [],
          },
        ],
      }),
      catalog,
    );
    expect(result.messages[0].updateComponents.components[0].entries).toEqual([
      'agent-two',
      'agent-one',
    ]);
    expect(result.limitations).toContain(LIMITATIONS.policy_unknown);
  });

  it.each([
    { ...plan, action: 'checkout' },
    { ...plan, answer: 'Fits every car' },
    {
      ...plan,
      components: [
        ...plan.components,
        { id: 'agent-evil', component: 'CartPanel' },
      ],
    },
    {
      ...plan,
      components: plan.components.map(node =>
        node.id === 'agent-one'
          ? { ...node, price: '$0.01', action: { event: { name: 'checkout' } } }
          : node,
      ),
    },
    {
      ...plan,
      components: plan.components.map(node =>
        node.id === 'agent-one' ? { ...node, name: { path: '/cart' } } : node,
      ),
    },
    {
      ...plan,
      components: plan.components.map(node =>
        node.id === 'agent-one' ? { ...node, productId: 999 } : node,
      ),
    },
    {
      ...plan,
      components: plan.components.map(node =>
        node.id === 'products' ? { ...node, entries: ['focus'] } : node,
      ),
    },
    {
      ...plan,
      components: plan.components.map(node =>
        node.id === 'agent-one' ? { ...node, id: 'configuration' } : node,
      ),
    },
    { ...plan, components: [...plan.components, plan.components[1]] },
    {
      ...plan,
      components: [
        ...plan.components,
        { id: 'agent-unused', component: 'ProductEntry', productId: 1 },
      ],
    },
  ])('rejects unsupported fields, actions, components, facts and graph references %#', invalid => {
    expect(() => compose(JSON.stringify(invalid), catalog)).toThrow(
      'invalid_output',
    );
  });

  it('rejects truncated and oversized output and unsafe catalog image URLs', () => {
    expect(() => compose('{', catalog)).toThrow('invalid_output');
    expect(() => compose(' '.repeat(32769), catalog)).toThrow('invalid_output');
    const result = compose(JSON.stringify(plan), [
      { ...catalog[0], image: 'javascript:alert(1)' },
      catalog[1],
    ]);
    expect(
      result.messages[0].updateComponents.components.find(
        node => node.id === 'agent-one',
      )?.image,
    ).toBe('');
  });
});
