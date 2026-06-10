// Catalog types
export interface Category {
  id: string;
  name: string;
  slug: string;
  icon?: string;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

export interface Topping {
  id: string;
  name: string;
  price: number;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface Product {
  id: string;
  slug: string;
  sku: string;
  name: string;
  description: string;
  price: number;
  originalPrice?: number;
  imageUrl: string;
  rating: number;
  reviewCount: number;
  spicyLevel?: number;
  isBestSeller: boolean;
  isNew: boolean;
  status: 'DRAFT' | 'ACTIVE' | 'ARCHIVED';
  stock: number;
  categoryId: string;
  category?: Category;
  createdAt: string;
  updatedAt: string;
}

export interface Promo {
  id: string;
  code: string;
  title: string;
  description: string;
  imageUrl?: string;
  voucherType: 'FREE_SHIPPING' | 'PERCENTAGE_DISCOUNT' | 'FIXED_DISCOUNT';
  discountPercentage?: number;
  discountAmount?: number;
  maxDiscountAmount?: number;
  freeShippingMaxAmount?: number;
  minimumOrderAmount: number;
  maxUsageCount?: number;
  currentUsageCount: number;
  isNewUserOnly: boolean;
  isActive: boolean;
  startDate?: string;
  endDate?: string;
  createdAt: string;
  updatedAt: string;
}

// Cart types
export interface CartItem {
  productId: string;
  quantity: number;
  toppingIds?: string[];
  spicyLevel?: number;
  notes?: string;
}

export interface CartSession {
  id: string;
  token: string;
  payload: unknown;
  expiresAt: string;
  createdAt: string;
  updatedAt: string;
}

// Address types
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
  createdAt: string;
  updatedAt: string;
}

// Order types
export enum OrderStatus {
  PENDING = 'PENDING',
  PROCESSING = 'PROCESSING',
  DELIVERING = 'DELIVERING',
  COMPLETED = 'COMPLETED',
  CANCELLED = 'CANCELLED',
}

export enum PaymentMethod {
  QRIS = 'QRIS',
  BANK_TRANSFER = 'BANK_TRANSFER',
  COD = 'COD',
}

export interface OrderItem {
  id: string;
  orderId: string;
  productId: string;
  productName: string;
  unitPrice: number;
  quantity: number;
  spicyLevel?: number;
  notes?: string;
  toppings?: OrderItemTopping[];
}

export interface OrderItemTopping {
  toppingId: string;
  name: string;
  price: number;
}

export interface Order {
  id: string;
  orderNumber: string;
  userId: string;
  addressId: string;
  voucherId?: string;
  voucherCode?: string;
  status: OrderStatus;
  subtotal: number;
  voucherDiscountAmount: number;
  deliveryFee: number;
  totalPrice: number;
  paymentMethod: PaymentMethod;
  notes?: string;
  estimatedDelivery?: string;
  items: OrderItem[];
  address?: Address;
  createdAt: string;
  updatedAt: string;
}

// Auth types
export interface AuthToken {
  accessToken: string;
  refreshToken: string;
  expiresIn?: number;
}

export interface User {
  id: string;
  email: string;
  name: string;
  googleId?: string;
  avatarUrl?: string;
  phone?: string;
  isOnboarded: boolean;
  isActive: boolean;
  addresses?: Address[];
  createdAt: string;
  updatedAt: string;
}

export interface AuthResponse {
  user: User;
  tokens: AuthToken;
}

export interface CreateAddressRequest {
  label: string;
  recipientName: string;
  phone: string;
  fullAddress: string;
  notes?: string;
  latitude: number;
  longitude: number;
  isDefault: boolean;
}

// API Response types
export interface ApiResponse<T> {
  data: T;
  message?: string;
  statusCode: number;
}

export interface ApiErrorResponse {
  message: string;
  statusCode: number;
  error?: unknown;
}

// Query/Search types
export interface ListProductsQuery {
  search?: string;
  category?: string;
  sort?: 'popular' | 'price-low' | 'price-high' | 'rating';
  skip?: number;
  take?: number;
}

export interface ValidateVoucherRequest {
  voucher_code: string;
  subtotal: number;
}

export type CheckoutCourier = 'paxel' | 'jne';

export interface CheckoutItemRequest {
  product_id: string;
  qty: number;
  topping_ids?: string[];
  spicyLevel?: number;
  notes?: string;
}

export interface ShippingCostRequest {
  address_id: string;
  courier: CheckoutCourier;
  items: CheckoutItemRequest[];
}

export interface ShippingCostResponse {
  shipping_cost: number;
  estimated_days: string;
}

export interface CheckoutSummaryRequest {
  address_id: string;
  courier: CheckoutCourier;
  voucher_code?: string;
  items: CheckoutItemRequest[];
}

export interface CheckoutSummaryResponse {
  subtotal: number;
  shipping_cost: number;
  discount: number;
  grand_total: number;
  total_items: number;
  estimated_days?: string;
}

export interface ValidateVoucherResponse {
  valid: boolean;
  discount: number;
  voucher_type: Promo['voucherType'] | null;
  message?: string;
}

export interface CreateOrderRequest {
  address_id: string;
  courier: CheckoutCourier;
  voucher_code?: string;
  items: CheckoutItemRequest[];
}
