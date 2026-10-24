/**
 * storefront's `main` search (Meilisearch) as board 41 shows it: three
 * indexes whose documents add up to the instance's 48,211, products with its
 * searchable fields, filters and 18 synonym sets, and a dozen real-looking
 * products so "Try it" has something to find.
 */
const MIN = 60_000;
const MB = 1024 * 1024;
const ago = (ms: number): string => new Date(Date.now() - ms).toISOString();

export interface DemoIndex {
  uid: string;
  primaryKey: string;
  docs: number;
  sizeBytes: number;
  updatedAt: string;
  searchable: string[];
  filterable: string[];
  sortable: string[];
  synonyms: Record<string, string[]>;
  sample: Array<Record<string, string | number | boolean>>;
}

const SETS: Array<[string, string]> = [
  ['cup', 'mug'], ['t-shirt', 'tee'], ['hoodie', 'sweatshirt'], ['sneakers', 'trainers'], ['jumper', 'sweater'],
  ['pants', 'trousers'], ['beanie', 'toque'], ['bag', 'tote'], ['bottle', 'flask'], ['journal', 'notebook'],
  ['biro', 'pen'], ['color', 'colour'], ['gray', 'grey'], ['coat', 'jacket'], ['shades', 'sunglasses'],
  ['hosiery', 'socks'], ['phone case', 'phone cover'], ['extra large', 'xl'],
];

export function mutual(sets: Array<[string, string]>): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [a, b] of sets) {
    out[a] = [b];
    out[b] = [a];
  }
  return out;
}

const P = (sku: string, title: string, brand: string, category: string, price: number, in_stock: boolean, description: string) => ({
  sku, title, brand, category, price, in_stock, description,
});

export function seedIndexes(): Record<string, DemoIndex[]> {
  return {
    'storefront/main': [
      {
        uid: 'products',
        primaryKey: 'sku',
        docs: 41_208,
        sizeBytes: 312 * MB,
        updatedAt: ago(4 * MIN),
        searchable: ['title', 'description', 'brand', 'sku'],
        filterable: ['category', 'price', 'in_stock'],
        sortable: ['price'],
        synonyms: mutual(SETS),
        sample: [
          P('MUG-0142', 'Enamel camp mug, 350 ml', 'Northwind', 'kitchen', 18, true, 'Speckled enamel mug for coffee at the campsite'),
          P('MUG-0188', 'Stoneware mug, sage glaze', 'Hearth & Co', 'kitchen', 24, true, 'Hand-thrown mug, dishwasher safe'),
          P('CUP-0007', 'Espresso cup set of two', 'Northwind', 'kitchen', 29, false, 'Double-walled glass cups'),
          P('TEE-1203', 'Organic cotton tee, navy', 'Fieldday', 'apparel', 32, true, 'Heavyweight t-shirt, relaxed fit'),
          P('TEE-1290', 'Pocket tee, heather grey', 'Fieldday', 'apparel', 28, true, 'Classic t-shirt with a chest pocket'),
          P('HOD-0410', 'Loopback hoodie, coral', 'Fieldday', 'apparel', 74, true, 'Brushed-back sweatshirt with a hood'),
          P('BTL-0031', 'Insulated bottle, 750 ml', 'Trailhead', 'outdoor', 36, true, 'Keeps drinks cold for 24 hours; a flask for the trail'),
          P('BAG-0920', 'Canvas tote bag', 'Northwind', 'accessories', 22, true, 'Waxed canvas tote with leather handles'),
          P('JRN-0077', 'Dot-grid notebook, A5', 'Paperline', 'stationery', 16, true, 'Lay-flat journal, 160 pages'),
          P('SNK-0555', 'Court sneakers, white', 'Stride', 'footwear', 110, false, 'Leather trainers with a gum sole'),
          P('JKT-0301', 'Waxed field jacket', 'Trailhead', 'outdoor', 189, true, 'Water-resistant coat with a corduroy collar'),
          P('SCK-0012', 'Merino hiking socks, 3 pairs', 'Trailhead', 'outdoor', 27, true, 'Cushioned socks for long walks'),
        ],
      },
      {
        uid: 'pages',
        primaryKey: 'slug',
        docs: 6_591,
        sizeBytes: 58 * MB,
        updatedAt: ago(2 * 24 * 60 * MIN),
        searchable: ['title', 'body'],
        filterable: ['locale'],
        sortable: [],
        synonyms: {},
        sample: [
          { slug: 'returns', title: 'Returns and refunds', locale: 'en', body: 'You have 30 days to send a mug, tee or anything else back.' },
          { slug: 'shipping', title: 'Shipping times', locale: 'en', body: 'Orders leave the warehouse within one working day.' },
        ],
      },
      {
        uid: 'categories',
        primaryKey: 'id',
        docs: 412,
        sizeBytes: 6 * MB,
        updatedAt: ago(3 * 60 * MIN),
        searchable: ['*'],
        filterable: [],
        sortable: [],
        synonyms: {},
        sample: [
          { id: 'kitchen', name: 'Kitchen', products: 3_204 },
          { id: 'apparel', name: 'Apparel', products: 12_880 },
        ],
      },
    ],
  };
}
