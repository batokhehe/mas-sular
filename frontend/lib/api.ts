import axios, { AxiosInstance, AxiosError } from 'axios';
import {
  Category,
  Topping,
  Product,
  Promo,
  CartSession,
  Order,
  AuthToken,
  AuthResponse,
  ListProductsQuery,
  ValidateVoucherRequest,
  ValidateVoucherResponse,
  CreateOrderRequest,
  ShippingCostRequest,
  ShippingCostResponse,
  CheckoutSummaryRequest,
  CheckoutSummaryResponse,
  CartItem,
  CreateAddressRequest,
  User,
  Address,
  ApiResponse,
  ApiErrorResponse,
} from './types';

// Initialize axios instance
const apiClient: AxiosInstance = axios.create({
  baseURL: process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3333/api/v1',
  timeout: 10000,
  headers: {
    'Content-Type': 'application/json',
  },
});

// Add interceptor to include auth token
apiClient.interceptors.request.use(
  (config) => {
    const token = localStorage.getItem('accessToken');
    if (token) {
      config.headers.Authorization = `Bearer ${token}`;
    }
    return config;
  },
  (error) => Promise.reject(error)
);

// Add interceptor to handle token refresh
apiClient.interceptors.response.use(
  (response) => response,
  async (error: AxiosError<ApiErrorResponse>) => {
    const originalRequest = error.config as any;

    if (error.response?.status === 401 && !originalRequest._retry) {
      originalRequest._retry = true;
      try {
        const refreshToken = localStorage.getItem('refreshToken');
        if (refreshToken) {
          const response = await axios.post(
            `${process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3333/api/v1'}/auth/refresh`,
            { refreshToken }
          );
          const { accessToken, refreshToken: newRefreshToken } = response.data;
          localStorage.setItem('accessToken', accessToken);
          localStorage.setItem('refreshToken', newRefreshToken);
          apiClient.defaults.headers.common.Authorization = `Bearer ${accessToken}`;
          return apiClient(originalRequest);
        }
      } catch (refreshError) {
        localStorage.removeItem('accessToken');
        localStorage.removeItem('refreshToken');
        window.location.href = '/login';
        return Promise.reject(refreshError);
      }
    }

    return Promise.reject(error);
  }
);

// ============ CATALOG API ============

export const catalogApi = {
  /**
   * Get list of products with optional filtering, searching, and sorting
   */
  async getProducts(query?: ListProductsQuery): Promise<Product[]> {
    const { data } = await apiClient.get<Product[]>('/catalog/products', { params: query });
    return data;
  },

  /**
   * Get single product by ID or slug
   */
  async getProduct(idOrSlug: string): Promise<Product> {
    const { data } = await apiClient.get<Product>(`/catalog/products/${idOrSlug}`);
    return data;
  },

  /**
   * Get all categories
   */
  async getCategories(): Promise<Category[]> {
    const { data } = await apiClient.get<Category[]>('/catalog/categories');
    return data;
  },

  /**
   * Get all toppings
   */
  async getToppings(): Promise<Topping[]> {
    const { data } = await apiClient.get<Topping[]>('/catalog/toppings');
    return data;
  },

  /**
   * Get all active promos/vouchers
   */
  async getPromos(): Promise<Promo[]> {
    const { data } = await apiClient.get<Promo[]>('/catalog/promos');
    return data;
  },
};

// ============ CART API ============

export const cartApi = {
  /**
   * Create a cart session
   */
  async createSession(items: CartItem[]): Promise<CartSession> {
    const { data } = await apiClient.post<CartSession>('/cart/sessions', { items });
    return data;
  },
};

// ============ ORDERS API ============

export const ordersApi = {
  /**
   * Create a new order (checkout)
   */
  async checkout(request: CreateOrderRequest): Promise<Order> {
    const { data } = await apiClient.post<Order>('/orders/checkout', request);
    return data;
  },

  /**
   * Validate and preview voucher discount
   */
  async validateVoucher(request: ValidateVoucherRequest): Promise<Promo> {
    const { data } = await apiClient.post<Promo>('/orders/voucher/preview', request);
    return data;
  },

  /**
   * Get orders for a user
   */
  async getUserOrders(userId: string, status?: string): Promise<Order[]> {
    const { data } = await apiClient.get<Order[]>(`/orders/users/${userId}`, {
      params: { status },
    });
    return data;
  },
};

// ============ CHECKOUT API ============

export const checkoutApi = {
  async getShippingCost(request: ShippingCostRequest): Promise<ShippingCostResponse> {
    const { data } = await apiClient.post<ShippingCostResponse>('/checkout/shipping-cost', request);
    return data;
  },

  async validateVoucher(request: ValidateVoucherRequest): Promise<ValidateVoucherResponse> {
    const { data } = await apiClient.post<ValidateVoucherResponse>('/checkout/validate-voucher', request);
    return data;
  },

  async getSummary(request: CheckoutSummaryRequest): Promise<CheckoutSummaryResponse> {
    const { data } = await apiClient.post<CheckoutSummaryResponse>('/checkout/summary', request);
    return data;
  },

  async createOrder(request: CreateOrderRequest): Promise<Order> {
    const { data } = await apiClient.post<Order>('/checkout/order', request);
    return data;
  },
};

// ============ USER API ============

export const userApi = {
  async getMe(): Promise<User> {
    const { data } = await apiClient.get<User>('/users/me');
    return data;
  },

  async getAddresses(): Promise<Address[]> {
    const { data } = await apiClient.get<Address[]>('/users/me/addresses');
    return data;
  },

  async createAddress(request: CreateAddressRequest): Promise<Address> {
    const { data } = await apiClient.post<Address>('/users/me/addresses', request);
    return data;
  },
};

// ============ AUTH API ============

export const authApi = {
  /**
   * Login with Google ID token
   */
  async loginWithGoogle(idToken: string): Promise<AuthResponse> {
    const { data } = await apiClient.post<AuthResponse>('/auth/google', { idToken });
    return data;
  },

  /**
   * Refresh access token
   */
  async refreshToken(refreshToken: string): Promise<AuthToken> {
    const { data } = await apiClient.post<AuthToken>('/auth/refresh', { refreshToken });
    return data;
  },

  /**
   * Store tokens in localStorage
   */
  setTokens(accessToken: string, refreshToken: string): void {
    localStorage.setItem('accessToken', accessToken);
    localStorage.setItem('refreshToken', refreshToken);
    apiClient.defaults.headers.common.Authorization = `Bearer ${accessToken}`;
  },

  /**
   * Clear tokens from localStorage
   */
  clearTokens(): void {
    localStorage.removeItem('accessToken');
    localStorage.removeItem('refreshToken');
    localStorage.removeItem('user');
    delete apiClient.defaults.headers.common.Authorization;
  },

  /**
   * Get stored access token
   */
  getAccessToken(): string | null {
    return localStorage.getItem('accessToken');
  },

  /**
   * Check if user is authenticated
   */
  isAuthenticated(): boolean {
    return !!localStorage.getItem('accessToken');
  },
};

export default apiClient;
