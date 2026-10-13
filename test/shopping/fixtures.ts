import type { CatalogItem } from '../../src/shopping/catalog';
import type { Composition } from '../../src/shopping/composition';

export const catalog: CatalogItem[] = [
  {
    id: 1,
    name: 'Pit tray',
    description: 'Organize small parts.',
    image: 'https://photos.example/tray.jpg',
    price: 12.5,
    sku: 'TRAY',
    fit: null,
  },
  {
    id: 2,
    name: 'Fan mount',
    description: 'A printed mount.',
    image: '',
    price: 7,
    sku: 'MOUNT',
    fit: null,
  },
];
export const plan: Composition = {
  answer: 'catalog',
  components: [
    {
      id: 'products',
      component: 'ProductRail',
      entries: ['agent-one', 'agent-two'],
    },
    { id: 'agent-one', component: 'ProductEntry', productId: 1 },
    { id: 'agent-two', component: 'ProductEntry', productId: 2 },
    {
      id: 'focus',
      component: 'ProductFocus',
      productId: 1,
      images: ['agent-photo'],
    },
    { id: 'agent-photo', component: 'DetailImage', productId: 1 },
  ],
};
export function completion(content = JSON.stringify(plan)) {
  return {
    choices: [{ finish_reason: 'stop', message: { content } }],
    usage: { prompt_tokens: 100, completion_tokens: 100 },
  };
}

/** Controlled assortment for contract checks, not production catalog or fit evidence. */
export const initialAssortment: CatalogItem[] = [
  'Tool holder',
  'Pit stand',
  '1/10 motor fan mount',
  'Mugen MBX8 1/8 fan mount',
  'Team Associated B6.4 or B7 fan shroud',
].map((name, index) => ({
  id: 101 + index,
  name,
  description: `Controlled fixture: ${name}.`,
  image: '',
  price: 10 + index,
  sku: `FIXTURE-${index}`,
  fit: null,
}));

export const bindingPlan = (productId = 101) => ({
  answer: 'catalog',
  components: [
    { id: 'products', component: 'ProductRail', entries: ['agent-item'] },
    {
      id: 'agent-item',
      component: 'ProductEntry',
      product: { path: `/agentCatalog/products/${productId}` },
    },
    {
      id: 'focus',
      component: 'ProductFocus',
      product: { path: `/agentCatalog/products/${productId}` },
      images: ['agent-photo'],
    },
    {
      id: 'agent-photo',
      component: 'DetailImage',
      product: { path: `/agentCatalog/products/${productId}` },
    },
  ],
});
