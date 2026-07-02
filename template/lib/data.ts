// Mock data for Baso Nusantara

export interface Product {
  id: string;
  name: string;
  description: string;
  price: number;
  originalPrice?: number;
  image: string;
  category: string;
  rating: number;
  reviewCount: number;
  spicyLevel?: number;
  isBestSeller?: boolean;
  isNew?: boolean;
  stock: number;
}

export interface Category {
  id: string;
  name: string;
  icon: string;
  slug: string;
}

export interface Promo {
  id: string;
  title: string;
  description: string;
  image: string;
  code: string;
  discount: number;
}

export interface Topping {
  id: string;
  name: string;
  price: number;
}

export interface Address {
  id: string;
  label: string;
  recipientName: string;
  phone: string;
  fullAddress: string;
  notes?: string;
  latitude: number;
  longitude: number;
  isDefault: boolean;
}

export interface Order {
  id: string;
  orderNumber: string;
  items: OrderItem[];
  status: 'pending' | 'processing' | 'delivering' | 'completed' | 'cancelled';
  totalPrice: number;
  deliveryFee: number;
  paymentMethod: string;
  address: Address;
  createdAt: string;
  estimatedDelivery?: string;
}

export interface OrderItem {
  product: Product;
  quantity: number;
  notes?: string;
  toppings?: Topping[];
  spicyLevel?: number;
}

export const categories: Category[] = [
  { id: '1', name: 'Baso Urat', icon: '🍖', slug: 'baso-urat' },
  { id: '2', name: 'Baso Mercon', icon: '🌶️', slug: 'baso-mercon' },
  { id: '3', name: 'Baso Keju', icon: '🧀', slug: 'baso-keju' },
  { id: '4', name: 'Baso Frozen', icon: '❄️', slug: 'baso-frozen' },
  { id: '5', name: 'Minuman', icon: '🥤', slug: 'minuman' },
];

export const products: Product[] = [
  {
    id: '1',
    name: 'Baso Urat Jumbo',
    description: 'Bakso urat pilihan dengan tekstur kenyal dan rasa daging sapi premium. Cocok untuk pecinta bakso dengan sensasi urat yang nikmat.',
    price: 45000,
    originalPrice: 55000,
    image: '/products/baso-urat-jumbo.jpg',
    category: 'baso-urat',
    rating: 4.8,
    reviewCount: 234,
    spicyLevel: 0,
    isBestSeller: true,
    stock: 50,
  },
  {
    id: '2',
    name: 'Baso Mercon Super Pedas',
    description: 'Bakso dengan sambal mercon yang meledak di mulut. Level kepedasan tinggi untuk pecinta pedas sejati.',
    price: 42000,
    image: '/products/baso-mercon.jpg',
    category: 'baso-mercon',
    rating: 4.7,
    reviewCount: 189,
    spicyLevel: 3,
    isBestSeller: true,
    stock: 35,
  },
  {
    id: '3',
    name: 'Baso Keju Mozarella',
    description: 'Bakso dengan isian keju mozarella yang meleleh. Perpaduan gurih daging dan creamy keju yang sempurna.',
    price: 48000,
    image: '/products/baso-keju.jpg',
    category: 'baso-keju',
    rating: 4.9,
    reviewCount: 312,
    spicyLevel: 0,
    isNew: true,
    stock: 40,
  },
  {
    id: '4',
    name: 'Baso Urat Spesial',
    description: 'Bakso urat dengan ukuran standar dan kualitas premium. Pilihan tepat untuk makan sehari-hari.',
    price: 35000,
    image: '/products/baso-urat-spesial.jpg',
    category: 'baso-urat',
    rating: 4.6,
    reviewCount: 156,
    spicyLevel: 0,
    stock: 60,
  },
  {
    id: '5',
    name: 'Baso Mercon Level 5',
    description: 'Bakso mercon dengan level kepedasan maksimal. Hanya untuk yang berani!',
    price: 45000,
    image: '/products/baso-mercon-level5.jpg',
    category: 'baso-mercon',
    rating: 4.5,
    reviewCount: 98,
    spicyLevel: 5,
    stock: 25,
  },
  {
    id: '6',
    name: 'Frozen Baso Urat (20pcs)',
    description: 'Paket bakso urat frozen isi 20 pcs. Praktis untuk stok di rumah.',
    price: 85000,
    originalPrice: 100000,
    image: '/products/frozen-baso-urat.jpg',
    category: 'baso-frozen',
    rating: 4.7,
    reviewCount: 267,
    stock: 100,
  },
  {
    id: '7',
    name: 'Frozen Baso Keju (15pcs)',
    description: 'Paket bakso keju frozen isi 15 pcs. Siap goreng atau rebus kapan saja.',
    price: 78000,
    image: '/products/frozen-baso-keju.jpg',
    category: 'baso-frozen',
    rating: 4.8,
    reviewCount: 198,
    isNew: true,
    stock: 80,
  },
  {
    id: '8',
    name: 'Es Teh Manis',
    description: 'Es teh manis segar dengan gula aren. Pelengkap sempurna untuk bakso.',
    price: 8000,
    image: '/products/es-teh.jpg',
    category: 'minuman',
    rating: 4.5,
    reviewCount: 445,
    stock: 200,
  },
  {
    id: '9',
    name: 'Es Jeruk Segar',
    description: 'Jeruk peras segar dengan es batu. Menyegarkan di cuaca panas.',
    price: 12000,
    image: '/products/es-jeruk.jpg',
    category: 'minuman',
    rating: 4.6,
    reviewCount: 312,
    stock: 150,
  },
  {
    id: '10',
    name: 'Baso Campur Spesial',
    description: 'Kombinasi bakso urat, bakso halus, dan mie dalam satu mangkuk. Porsi besar dan mengenyangkan.',
    price: 55000,
    image: '/products/baso-campur.jpg',
    category: 'baso-urat',
    rating: 4.9,
    reviewCount: 523,
    isBestSeller: true,
    stock: 45,
  },
  {
    id: '11',
    name: 'Baso Keju Cheddar',
    description: 'Bakso dengan isian keju cheddar yang gurih dan lumer.',
    price: 44000,
    image: '/products/baso-keju-cheddar.jpg',
    category: 'baso-keju',
    rating: 4.7,
    reviewCount: 178,
    stock: 55,
  },
  {
    id: '12',
    name: 'Frozen Mix (30pcs)',
    description: 'Paket frozen campuran: 10 baso urat, 10 baso keju, 10 baso mercon.',
    price: 125000,
    originalPrice: 150000,
    image: '/products/frozen-mix.jpg',
    category: 'baso-frozen',
    rating: 4.8,
    reviewCount: 89,
    isBestSeller: true,
    stock: 60,
  },
];

export const toppings: Topping[] = [
  { id: '1', name: 'Mie Kuning', price: 5000 },
  { id: '2', name: 'Bihun', price: 5000 },
  { id: '3', name: 'Tahu Goreng', price: 3000 },
  { id: '4', name: 'Siomay', price: 4000 },
  { id: '5', name: 'Pangsit Goreng', price: 4000 },
  { id: '6', name: 'Telur Puyuh', price: 5000 },
  { id: '7', name: 'Extra Sambal', price: 2000 },
  { id: '8', name: 'Kerupuk', price: 3000 },
];

export const promos: Promo[] = [
  {
    id: '1',
    title: 'Diskon 20% Pembelian Pertama',
    description: 'Khusus pengguna baru, nikmati diskon 20% untuk pembelian pertama Anda!',
    image: '/promos/new-user.jpg',
    code: 'NEWUSER20',
    discount: 20,
  },
  {
    id: '2',
    title: 'Gratis Ongkir',
    description: 'Gratis ongkir untuk pembelian minimal Rp 100.000',
    image: '/promos/free-delivery.jpg',
    code: 'FREEONGKIR',
    discount: 0,
  },
  {
    id: '3',
    title: 'Paket Hemat Weekend',
    description: 'Beli 2 dapat potongan 15% setiap Sabtu-Minggu',
    image: '/promos/weekend-deal.jpg',
    code: 'WEEKEND15',
    discount: 15,
  },
];

export const sampleOrders: Order[] = [
  {
    id: '1',
    orderNumber: 'BN-20240315-001',
    items: [
      {
        product: products[0],
        quantity: 2,
        spicyLevel: 1,
        toppings: [toppings[0], toppings[2]],
      },
      {
        product: products[7],
        quantity: 2,
      },
    ],
    status: 'completed',
    totalPrice: 106000,
    deliveryFee: 10000,
    paymentMethod: 'QRIS',
    address: {
      id: '1',
      label: 'Rumah',
      recipientName: 'John Doe',
      phone: '08123456789',
      fullAddress: 'Jl. Sudirman No. 123, Jakarta Pusat',
      latitude: -6.2088,
      longitude: 106.8456,
      isDefault: true,
    },
    createdAt: '2024-03-15T10:30:00Z',
  },
  {
    id: '2',
    orderNumber: 'BN-20240316-002',
    items: [
      {
        product: products[2],
        quantity: 1,
        toppings: [toppings[1]],
      },
    ],
    status: 'delivering',
    totalPrice: 53000,
    deliveryFee: 10000,
    paymentMethod: 'COD',
    address: {
      id: '1',
      label: 'Rumah',
      recipientName: 'John Doe',
      phone: '08123456789',
      fullAddress: 'Jl. Sudirman No. 123, Jakarta Pusat',
      latitude: -6.2088,
      longitude: 106.8456,
      isDefault: true,
    },
    createdAt: '2024-03-16T14:15:00Z',
    estimatedDelivery: '2024-03-16T15:00:00Z',
  },
  {
    id: '3',
    orderNumber: 'BN-20240317-003',
    items: [
      {
        product: products[5],
        quantity: 1,
      },
    ],
    status: 'processing',
    totalPrice: 95000,
    deliveryFee: 10000,
    paymentMethod: 'Bank Transfer',
    address: {
      id: '2',
      label: 'Kantor',
      recipientName: 'John Doe',
      phone: '08123456789',
      fullAddress: 'Jl. Gatot Subroto No. 45, Jakarta Selatan',
      latitude: -6.2350,
      longitude: 106.8220,
      isDefault: false,
    },
    createdAt: '2024-03-17T09:00:00Z',
  },
];

export function formatPrice(price: number): string {
  return new Intl.NumberFormat('id-ID', {
    style: 'currency',
    currency: 'IDR',
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(price);
}

export function formatDate(dateString: string): string {
  return new Date(dateString).toLocaleDateString('id-ID', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}
