import { PrismaClient, ProductStatus } from '@prisma/client';

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

const promoSpecialSlugs = [
  'baso-urat-jumbo',
  'frozen-baso-urat-20pcs',
  'baso-keju-mozarella',
] as const;

const trialPackSlugs = [
  'baso-urat-jumbo',
  'baso-mercon-super-pedas',
  'baso-keju-mozarella',
  'frozen-baso-urat-20pcs',
] as const;

const toppings = [
  ['Mie Kuning', 5000],
  ['Bihun', 5000],
  ['Tahu Goreng', 3000],
  ['Siomay', 4000],
  ['Pangsit Goreng', 4000],
  ['Telur Puyuh', 5000],
  ['Extra Sambal', 2000],
  ['Kerupuk', 3000],
] as const;

async function main(): Promise<void> {
  for (const [index, category] of categories.entries()) {
    await prisma.category.upsert({
      where: { slug: category.slug },
      update: { ...category, sortOrder: index },
      create: { ...category, sortOrder: index },
    });
  }

  const categoryBySlug = new Map(
    (await prisma.category.findMany()).map((c) => [c.slug, c.id]),
  );

  for (const p of products) {
    const [
      slug,
      name,
      price,
      originalPrice,
      imageUrl,
      categorySlug,
      rating,
      reviewCount,
      spicyLevel,
      isBestSeller,
      isNew,
      stock,
    ] = p;

    await prisma.product.upsert({
      where: { slug },
      update: {},
      create: {
        slug,
        sku: slug.toUpperCase().replaceAll('-', '_'),
        name,
        description: `${name} premium Bakso Mas Sular dengan bahan berkualitas dan rasa autentik.`,
        price,
        originalPrice,
        imageUrl,
        categoryId: categoryBySlug.get(categorySlug)!,
        rating,
        reviewCount,
        spicyLevel,
        isBestSeller,
        isNew,
        isPromoSpecial: (promoSpecialSlugs as readonly string[]).includes(slug),
        isTrialPack: (trialPackSlugs as readonly string[]).includes(slug),
        stock,
        status: ProductStatus.ACTIVE,
      },
    });
  }

  await prisma.product.updateMany({
    where: { slug: { in: [...promoSpecialSlugs] } },
    data: { isPromoSpecial: true },
  });

  await prisma.product.updateMany({
    where: { slug: { in: [...trialPackSlugs] } },
    data: { isTrialPack: true },
  });

  for (const [name, price] of toppings) {
    const id = name.toLowerCase().replaceAll(' ', '-');

    await prisma.topping.upsert({
      where: { id },
      update: {},
      create: {
        id,
        name,
        price,
      },
    });
  }

  console.log(
    `[seed-catalog] Done. Categories=${categories.length} Products=${products.length} Toppings=${toppings.length}`,
  );
}

main()
  .catch((e) => {
    console.error('[seed-catalog] Failed:', e);
    process.exit(1);
  })
  .finally(() => {
    void prisma.$disconnect();
  });
