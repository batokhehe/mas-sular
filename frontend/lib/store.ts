import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { Topping, Address } from './data';
import { getProductImageSrc } from './product-images';

export type CartProduct = {
  id: string;
  name: string;
  price: number;
  description?: string;
  image?: string;
  imageUrl?: string;
  originalPrice?: number;
  rating?: number | string;
  reviewCount?: number;
  spicyLevel?: number;
  isBestSeller?: boolean;
  isNew?: boolean;
  stock?: number;
  slug?: string;
  sku?: string;
  category?: unknown;
  categoryId?: string;
  status?: string;
  createdAt?: string;
  updatedAt?: string;
};

export interface CartItem {
  id: string;
  product: CartProduct;
  quantity: number;
  notes?: string;
  toppings: Topping[];
  spicyLevel: number;
}

interface User {
  id: string;
  name: string;
  email: string;
  avatar?: string;
}

interface CartState {
  items: CartItem[];
  addItem: (item: Omit<CartItem, 'id'>) => void;
  removeItem: (id: string) => void;
  updateQuantity: (id: string, quantity: number) => void;
  updateNotes: (id: string, notes: string) => void;
  clearCart: () => void;
  getTotalItems: () => number;
  getTotalPrice: () => number;
}

interface AuthState {
  user: User | null;
  isAuthenticated: boolean;
  isOnboarded: boolean;
  login: (user: User) => void;
  logout: () => void;
  completeOnboarding: () => void;
}

interface AddressState {
  addresses: Address[];
  selectedAddressId: string | null;
  addAddress: (address: Address) => void;
  updateAddress: (id: string, address: Partial<Address>) => void;
  removeAddress: (id: string) => void;
  selectAddress: (id: string) => void;
  getSelectedAddress: () => Address | null;
}

interface FavoritesState {
  favorites: string[];
  toggleFavorite: (productId: string) => void;
  isFavorite: (productId: string) => boolean;
}

function getCartItemKey(item: Omit<CartItem, 'id'>) {
  const toppings = Array.isArray(item.toppings) ? item.toppings : [];
  const toppingIds = [...toppings.map((t) => t.id)].sort();
  return `${item.product.id}-${item.spicyLevel}-${toppingIds.join('-')}-${item.notes || ''}`;
}

function normalizeCartItems(items: CartItem[]) {
  const itemsByKey = new Map<string, CartItem>();

  items.forEach((item) => {
    if (!item?.product?.id) return;

    const id = getCartItemKey(item);
    const existingItem = itemsByKey.get(id);
    const quantity = Number.isFinite(item.quantity) && item.quantity > 0 ? item.quantity : 1;
    const normalizedItem = {
      ...item,
      id,
      quantity,
      toppings: Array.isArray(item.toppings) ? item.toppings : [],
      product: {
        ...item.product,
        image: getProductImageSrc(item.product),
      },
    };

    if (existingItem) {
      itemsByKey.set(id, {
        ...existingItem,
        quantity: existingItem.quantity + item.quantity,
      });
      return;
    }

    itemsByKey.set(id, normalizedItem);
  });

  return Array.from(itemsByKey.values());
}

export const useCartStore = create<CartState>()(
  persist(
    (set, get) => ({
      items: [],
      addItem: (item) => {
        set((state) => {
          if (item.quantity <= 0) {
            return state;
          }

          const id = getCartItemKey(item);
          return {
            items: normalizeCartItems([
              ...state.items,
              {
                ...item,
                id,
                product: {
                  ...item.product,
                  image: getProductImageSrc(item.product),
                },
              },
            ]),
          };
        });
      },
      removeItem: (id) => {
        set((state) => ({
          items: state.items.filter((item) => item.id !== id),
        }));
      },
      updateQuantity: (id, quantity) => {
        if (quantity <= 0) {
          get().removeItem(id);
          return;
        }
        set((state) => ({
          items: state.items.map((item) =>
            item.id === id ? { ...item, quantity } : item
          ),
        }));
      },
      updateNotes: (id, notes) => {
        set((state) => ({
          items: state.items.map((item) =>
            item.id === id ? { ...item, notes } : item
          ),
        }));
      },
      clearCart: () => set({ items: [] }),
      getTotalItems: () => {
        return get().items.reduce((total, item) => total + item.quantity, 0);
      },
      getTotalPrice: () => {
        return get().items.reduce((total, item) => {
          const toppingsPrice = item.toppings.reduce((sum, t) => sum + t.price, 0);
          return total + (item.product.price + toppingsPrice) * item.quantity;
        }, 0);
      },
    }),
    {
      name: 'baso-cart',
      version: 2,
      migrate: (persistedState) => {
        const state = persistedState as CartState;
        return {
          ...state,
          items: normalizeCartItems(state.items || []),
        };
      },
    }
  )
);

export const useAuthStore = create<AuthState>()(
  persist(
    (set) => ({
      user: null,
      isAuthenticated: false,
      isOnboarded: false,
      login: (user) => set({ user, isAuthenticated: true }),
      logout: () => set({ user: null, isAuthenticated: false, isOnboarded: false }),
      completeOnboarding: () => set({ isOnboarded: true }),
    }),
    {
      name: 'baso-auth',
    }
  )
);

export const useAddressStore = create<AddressState>()(
  persist(
    (set, get) => ({
      addresses: [],
      selectedAddressId: null,
      addAddress: (address) => {
        set((state) => {
          const newAddresses = state.addresses.map((a) => ({
            ...a,
            isDefault: address.isDefault ? false : a.isDefault,
          }));
          return {
            addresses: [...newAddresses, address],
            selectedAddressId: address.isDefault ? address.id : state.selectedAddressId,
          };
        });
      },
      updateAddress: (id, updates) => {
        set((state) => ({
          addresses: state.addresses.map((a) =>
            a.id === id ? { ...a, ...updates } : a
          ),
        }));
      },
      removeAddress: (id) => {
        set((state) => ({
          addresses: state.addresses.filter((a) => a.id !== id),
          selectedAddressId: state.selectedAddressId === id ? null : state.selectedAddressId,
        }));
      },
      selectAddress: (id) => set({ selectedAddressId: id }),
      getSelectedAddress: () => {
        const { addresses, selectedAddressId } = get();
        return addresses.find((a) => a.id === selectedAddressId) || addresses.find((a) => a.isDefault) || null;
      },
    }),
    {
      name: 'baso-addresses',
    }
  )
);

export const useFavoritesStore = create<FavoritesState>()(
  persist(
    (set, get) => ({
      favorites: [],
      toggleFavorite: (productId) => {
        set((state) => ({
          favorites: state.favorites.includes(productId)
            ? state.favorites.filter((id) => id !== productId)
            : [...state.favorites, productId],
        }));
      },
      isFavorite: (productId) => get().favorites.includes(productId),
    }),
    {
      name: 'baso-favorites',
    }
  )
);
