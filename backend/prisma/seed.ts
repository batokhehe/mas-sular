import * as bcrypt from 'bcryptjs';
import { PrismaClient, ProductStatus } from '@prisma/client';
import { assertDevSeedAllowed } from './bootstrap/dev-seed-guard';
import { ensureRbac } from './bootstrap/rbac';

// DEVELOPMENT ONLY. Production databases are initialised with
// prisma/bootstrap-production.ts; this seed refuses NODE_ENV=production (B5).
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

/**
 * P2 #10: the three initial "Promo Spesial Produk" products (local/dev seed only).
 * Existing seeded products, chosen by slug so the choice is deterministic.
 */
const PROMO_SPECIAL_SLUGS = ['baso-urat-jumbo', 'frozen-baso-urat-20pcs', 'baso-keju-mozarella'] as const;

/**
 * P2 #11: the four initial "Trial Pack" products (local/dev seed only) - the four
 * bakso products, so a customer can try the range. Es Teh Manis (a drink add-on)
 * is left out. Existing seeded products, chosen by slug.
 */
const TRIAL_PACK_SLUGS = ['baso-urat-jumbo', 'baso-mercon-super-pedas', 'baso-keju-mozarella', 'frozen-baso-urat-20pcs'] as const;

async function main(): Promise<void> {
  // Before ANY database access.
  assertDevSeedAllowed(process.env);

  // Roles, permissions and SUPER_ADMIN's grants - the same catalogue the production
  // bootstrap uses (prisma/bootstrap/rbac.ts).
  const rbac = await ensureRbac(prisma);

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
        isPromoSpecial: (PROMO_SPECIAL_SLUGS as readonly string[]).includes(slug),
        isTrialPack: (TRIAL_PACK_SLUGS as readonly string[]).includes(slug),
        stock,
        status: ProductStatus.ACTIVE,
      },
    });
  }

  // Idempotent for databases seeded before the flags existed: each call sets ONLY
  // its own flag, only on its own products. No other product or field is touched.
  await prisma.product.updateMany({
    where: { slug: { in: [...PROMO_SPECIAL_SLUGS] } },
    data: { isPromoSpecial: true },
  });
  await prisma.product.updateMany({
    where: { slug: { in: [...TRIAL_PACK_SLUGS] } },
    data: { isTrialPack: true },
  });

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
      voucherType: 'PERCENTAGE_DISCOUNT',
      discountPercentage: 20,
      minimumOrderAmount: 0,
      isNewUserOnly: true,
      isActive: true,
    },
  });

  const adminPasswordHash = await bcrypt.hash('admin', 12);
  const adminUser = await prisma.admin.upsert({
    where: { email: 'admin@test.com' },
    update: {
      name: 'Super Admin',
      passwordHash: adminPasswordHash,
      isActive: true,
    },
    create: {
      email: 'admin@test.com',
      passwordHash: adminPasswordHash,
      name: 'Super Admin',
      isActive: true,
    },
  });

  // One active, visible payment account so checkout WhatsApp notifications resolve.
  await prisma.paymentAccount.upsert({
    where: { accountNumber: '1234567890' },
    update: {},
    create: {
      bankName: 'BCA',
      bankCode: '014',
      accountName: 'Bakso Mas Sular',
      accountNumber: '1234567890',
      isActive: true,
      isVisible: true,
      displayOrder: 0,
    },
  });

  // DEVELOPMENT-ONLY outlet.
  //
  // OutletBootValidator refuses to boot the API when a shipping provider is
  // enabled (PAXEL_ENABLED/JNE_ENABLED) but no ACTIVE outlet exists — correctly,
  // because providers use the active outlet as the shipping origin. Outlets are
  // otherwise created through the admin UI, so a freshly migrated database had
  // no way to reach a bootable state and `docker compose up` crash-looped.
  //
  // Deliberately minimal: only what the validator needs (an active outlet) plus
  // the origin address and postal code the environment is ALREADY configured with
  // (SHIPPING_ORIGIN_POSTAL_CODE=40286). No coordinates, region ids or phone are
  // invented here — a real outlet is registered by an operator through the admin
  // UI, which overwrites nothing below because this row is keyed on its own id.
  //
  // Idempotent via a deterministic id (the same approach the toppings above use),
  // since Outlet has no unique column other than the primary key. `update: {}` so
  // re-seeding never clobbers edits an operator made to this row.
  await prisma.outlet.upsert({
    where: { id: 'local-dev-outlet' },
    update: {},
    create: {
      id: 'local-dev-outlet',
      name: 'Local Dev Outlet',
      addressDetail:
        'Jl. Saturnus Sel. No.3, Margasari, Kec. Buahbatu, Kota Bandung, Jawa Barat 40286',
      postalCode: '40286',
      isActive: true,
    },
  });

  // Link the development admin to SUPER_ADMIN (grants come from ensureRbac above).
  await prisma.adminRole.upsert({
    where: { adminId_roleId: { adminId: adminUser.id, roleId: rbac.superAdminRoleId } },
    update: {},
    create: { adminId: adminUser.id, roleId: rbac.superAdminRoleId },
  });
}

main()
  .catch((err: unknown) => {
    console.error(`[seed] ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  })
  .finally(async () => prisma.$disconnect());
