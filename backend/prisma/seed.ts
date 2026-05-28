import { PrismaClient, ProductStatus, RoleName } from '@prisma/client';

const prisma = new PrismaClient();

const categories = [
  { name: 'Baso Urat', slug: 'baso-urat', icon: '🍖' },
  { name: 'Baso Mercon', slug: 'baso-mercon', icon: '🌶️' },
  { name: 'Baso Keju', slug: 'baso-keju', icon: '🧀' },
  { name: 'Baso Frozen', slug: 'baso-frozen', icon: '❄️' },
  { name: 'Minuman', slug: 'minuman', icon: '🥤' },
];

const products = [
  ['baso-urat-jumbo', 'Baso Urat Jumbo', 45000, 55000, '/products/baso-urat-jumbo.jpg', 'baso-urat', 4.8, 234, 0, true, false, 50],
  ['baso-mercon-super-pedas', 'Baso Mercon Super Pedas', 42000, null, '/products/baso-mercon.jpg', 'baso-mercon', 4.7, 189, 3, true, false, 35],
  ['baso-keju-mozarella', 'Baso Keju Mozarella', 48000, null, '/products/baso-keju.jpg', 'baso-keju', 4.9, 312, 0, false, true, 40],
  ['frozen-baso-urat-20pcs', 'Frozen Baso Urat (20pcs)', 85000, 100000, '/products/frozen-baso-urat.jpg', 'baso-frozen', 4.7, 267, null, false, false, 100],
  ['es-teh-manis', 'Es Teh Manis', 8000, null, '/products/es-teh.jpg', 'minuman', 4.5, 445, null, false, false, 200],
] as const;

async function main(): Promise<void> {
  for (const role of Object.values(RoleName)) {
    await prisma.role.upsert({ where: { name: role }, update: {}, create: { name: role } });
  }

  for (const [index, category] of categories.entries()) {
    await prisma.category.upsert({
      where: { slug: category.slug },
      update: { ...category, sortOrder: index },
      create: { ...category, sortOrder: index },
    });
  }

  const categoryBySlug = new Map((await prisma.category.findMany()).map((c) => [c.slug, c.id]));

  for (const p of products) {
    const [slug, name, price, originalPrice, imageUrl, categorySlug, rating, reviewCount, spicyLevel, isBestSeller, isNew, stock] = p;
    await prisma.product.upsert({
      where: { slug },
      update: {},
      create: {
        slug,
        sku: slug.toUpperCase().replaceAll('-', '_'),
        name,
        description: `${name} premium Baso Nusantara dengan bahan berkualitas dan rasa autentik.`,
        price,
        originalPrice,
        imageUrl,
        categoryId: categoryBySlug.get(categorySlug)!,
        rating,
        reviewCount,
        spicyLevel,
        isBestSeller,
        isNew,
        stock,
        status: ProductStatus.ACTIVE,
      },
    });
  }

  for (const topping of [
    ['Mie Kuning', 5000],
    ['Bihun', 5000],
    ['Tahu Goreng', 3000],
    ['Siomay', 4000],
    ['Pangsit Goreng', 4000],
    ['Telur Puyuh', 5000],
    ['Extra Sambal', 2000],
    ['Kerupuk', 3000],
  ] as const) {
    await prisma.topping.upsert({
      where: { id: topping[0].toLowerCase().replaceAll(' ', '-') },
      update: {},
      create: { id: topping[0].toLowerCase().replaceAll(' ', '-'), name: topping[0], price: topping[1] },
    });
  }

  await prisma.promo.upsert({
    where: { code: 'NEWUSER20' },
    update: {},
    create: {
      code: 'NEWUSER20',
      title: 'Diskon 20% Pembelian Pertama',
      description: 'Khusus pengguna baru.',
      discountPct: 20,
      isActive: true,
    },
  });
}

main().finally(async () => prisma.$disconnect());
