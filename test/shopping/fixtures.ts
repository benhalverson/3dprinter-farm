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
