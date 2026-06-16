// Mirrors backend Prisma enums exactly (schema.prisma).

export const OrderStatus = {
  PENDING: 'PENDING',
  PROCESSING: 'PROCESSING',
  PACKING: 'PACKING',
  SHIPPED: 'SHIPPED',
  DELIVERING: 'DELIVERING',
  DELIVERED: 'DELIVERED',
  COMPLETED: 'COMPLETED',
  CANCELLED: 'CANCELLED',
} as const
export type OrderStatus = keyof typeof OrderStatus

export const PaymentStatus = {
  PENDING: 'PENDING',
  WAITING_VERIFICATION: 'WAITING_VERIFICATION',
  PAID: 'PAID',
  FAILED: 'FAILED',
  EXPIRED: 'EXPIRED',
  REFUNDED: 'REFUNDED',
} as const
export type PaymentStatus = keyof typeof PaymentStatus

export const PaymentMethod = {
  QRIS: 'QRIS',
  BANK_TRANSFER: 'BANK_TRANSFER',
  COD: 'COD',
  GATEWAY: 'GATEWAY',
} as const
export type PaymentMethod = keyof typeof PaymentMethod

export const ShipmentStatus = {
  PENDING: 'PENDING',
  RATE_SELECTED: 'RATE_SELECTED',
  PICKED_UP: 'PICKED_UP',
  IN_TRANSIT: 'IN_TRANSIT',
  DELIVERED: 'DELIVERED',
  FAILED: 'FAILED',
} as const
export type ShipmentStatus = keyof typeof ShipmentStatus

export const VoucherType = {
  FREE_SHIPPING: 'FREE_SHIPPING',
  PERCENTAGE_DISCOUNT: 'PERCENTAGE_DISCOUNT',
  FIXED_DISCOUNT: 'FIXED_DISCOUNT',
} as const
export type VoucherType = keyof typeof VoucherType

export const ProductStatus = { DRAFT: 'DRAFT', ACTIVE: 'ACTIVE', ARCHIVED: 'ARCHIVED' } as const
export type ProductStatus = keyof typeof ProductStatus

export const CheckoutCourier = { PAXEL: 'paxel', JNE: 'jne' } as const
export type CheckoutCourier = (typeof CheckoutCourier)[keyof typeof CheckoutCourier]

// Permissions are data-driven `Subject.action` strings (not a Prisma enum).
// This union lists exactly the strings enforced by the backend @Permissions decorators.
export type AdminPermission =
  | 'Dashboard.read'
  | 'Order.read'
  | 'Order.update'
  | 'Payment.read'
  | 'Payment.verify'
  | 'Payment.reject'
  | 'Shipment.create'
  | 'Shipment.read'
  | 'Shipment.update'
  | 'Shipment.delete'
  | 'User.read'
  | 'User.update'
  | 'Role.create'
  | 'Role.read'
  | 'Role.update'
  | 'Product.create'
  | 'Product.read'
  | 'Product.update'
  | 'Product.delete'
  | 'Category.create'
  | 'Category.read'
  | 'Category.update'
  | 'Category.delete'
  | 'Promo.create'
  | 'Promo.read'
  | 'Promo.update'
  | 'Promo.delete'
  | 'Banner.create'
  | 'Banner.read'
  | 'Banner.update'
  | 'Banner.delete'
