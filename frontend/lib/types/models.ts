// Response models mirror backend schema.prisma columns + the relations each
// endpoint includes. Backend returns raw Prisma objects, so unlisted fields may
// be present — treat them as optional.
import type {
  OrderStatus,
  PaymentStatus,
  PaymentMethod,
  ShipmentStatus,
  VoucherType,
  ProductStatus,
  AdminPermission,
} from './enums'

export interface AuthTokens {
  accessToken: string
  refreshToken: string
}

export interface AdminSession {
  id: string
  email: string
  name: string
  isActive: boolean
  permissions: AdminPermission[]
}

export interface User {
  id: string
  email: string
  name: string
  avatarUrl?: string | null
  phone?: string | null
  isOnboarded: boolean
  isActive: boolean
  roles?: { role: { name: string } }[]
  addresses?: Address[]
  createdAt: string
}

export interface Address {
  id: string
  userId: string
  label: string
  recipientName: string
  phone: string
  fullAddress: string
  notes?: string | null
  latitude: string
  longitude: string
  isDefault: boolean
}

export interface Product {
  id: string
  slug: string
  sku: string
  name: string
  description: string
  price: number
  originalPrice?: number | null
  imageUrl: string
  rating: string
  reviewCount: number
  spicyLevel?: number | null
  isBestSeller: boolean
  isNew: boolean
  status: ProductStatus
  stock: number
  categoryId: string
}

export interface Category {
  id: string
  name: string
  slug: string
  icon?: string | null
  sortOrder: number
}

export interface Topping {
  id: string
  name: string
  price: number
  isActive: boolean
}

export interface Promo {
  id: string
  code: string
  title: string
  description: string
  voucherType: VoucherType
  discountPercentage?: number | null
  discountAmount?: number | null
  minimumOrderAmount: number
  isActive: boolean
}

export interface CheckoutItem {
  product_id: string
  qty: number
  topping_ids?: string[]
  spicyLevel?: number
  notes?: string
}

export interface ShippingQuote {
  shipping_cost: number
  estimated_days: string
}

export interface VoucherPreview {
  valid: boolean
  discount: number
  voucher_type: VoucherType
}

export interface CheckoutSummary {
  subtotal: number
  shipping_cost: number
  discount: number
  grand_total: number
  estimated_days?: string
  voucher?: Promo | null
}

export interface UploadPage {
  orderNumber: string
  amount: number
  method: PaymentMethod
  bankName?: string | null
  status: PaymentStatus
}

export interface OrderItem {
  id: string
  productId: string
  productName: string
  unitPrice: number
  quantity: number
  spicyLevel?: number | null
  notes?: string | null
  toppings: { name: string; price: number }[]
}

export interface Payment {
  id: string
  orderId: string
  method: PaymentMethod
  status: PaymentStatus
  amount: number
  manualReceiptUrl?: string | null
  manualBankName?: string | null
  manualAccountName?: string | null
  verifiedAt?: string | null
  firstReminderAt?: string | null
  secondReminderAt?: string | null
  createdAt: string
  // Included by the admin listPayments endpoint.
  order?: {
    id: string
    orderNumber: string
    totalPrice: number
    user?: { id: string; name: string; email: string; phone?: string | null }
  }
}

export interface Shipment {
  id: string
  orderId: string
  provider: string
  service: string
  status: ShipmentStatus
  cost: number
  trackingNumber?: string | null
  trackingUrl?: string | null
}

export interface OrderEvent {
  id: string
  status: OrderStatus
  note?: string | null
  createdAt: string
}

export interface Order {
  id: string
  orderNumber: string
  userId: string
  addressId: string
  status: OrderStatus
  subtotal: number
  voucherDiscountAmount: number
  deliveryFee: number
  totalPrice: number
  paymentMethod: PaymentMethod
  voucherCode?: string | null
  estimatedDelivery?: string | null
  createdAt: string
  items?: OrderItem[]
  address?: Address
  payment?: Payment | null
  shipment?: Shipment | null
  events?: OrderEvent[]
  user?: { id: string; name: string; email: string; phone?: string | null }
}

export interface UploadResult {
  url: string
}
