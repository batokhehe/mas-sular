'use client';

import { useQuery, useMutation, useQueryClient, UseQueryOptions, UseMutationOptions } from '@tanstack/react-query';
import {
    catalogApi,
    cartApi,
    checkoutApi,
    ordersApi,
    authApi,
} from '@/lib/api';
import {
    Category,
    Topping,
    Product,
    Promo,
    Order,
    AuthResponse,
    CartSession,
    ListProductsQuery,
    ValidateVoucherRequest,
    ValidateVoucherResponse,
    CreateOrderRequest,
    CartItem,
} from '@/lib/types';

// ============ QUERY KEYS ============

export const catalogKeys = {
    all: ['catalog'] as const,
    products: () => [...catalogKeys.all, 'products'] as const,
    productsList: (query?: ListProductsQuery) => [...catalogKeys.products(), { query }] as const,
    product: (idOrSlug: string) => [...catalogKeys.products(), idOrSlug] as const,
    categories: () => [...catalogKeys.all, 'categories'] as const,
    toppings: () => [...catalogKeys.all, 'toppings'] as const,
    promos: () => [...catalogKeys.all, 'promos'] as const,
};

export const orderKeys = {
    all: ['orders'] as const,
    lists: () => [...orderKeys.all, 'list'] as const,
    list: (userId: string, status?: string) => [...orderKeys.lists(), { userId, status }] as const,
    details: () => [...orderKeys.all, 'detail'] as const,
    detail: (id: string) => [...orderKeys.details(), id] as const,
};

export const authKeys = {
    all: ['auth'] as const,
    me: () => [...authKeys.all, 'me'] as const,
};

// ============ CATALOG HOOKS ============

export function useProducts(query?: ListProductsQuery, options?: UseQueryOptions<Product[]>) {
    return useQuery<Product[]>({
        queryKey: catalogKeys.productsList(query),
        queryFn: () => catalogApi.getProducts(query),
        retry: 1,
        staleTime: 5 * 60 * 1000, // 5 minutes
        ...options,
    });
}

export function useProduct(idOrSlug: string, options?: UseQueryOptions<Product>) {
    return useQuery<Product>({
        queryKey: catalogKeys.product(idOrSlug),
        queryFn: () => catalogApi.getProduct(idOrSlug),
        enabled: !!idOrSlug,
        retry: 1,
        staleTime: 10 * 60 * 1000, // 10 minutes
        ...options,
    });
}

export function useCategories(options?: UseQueryOptions<Category[]>) {
    return useQuery<Category[]>({
        queryKey: catalogKeys.categories(),
        queryFn: () => catalogApi.getCategories(),
        retry: 1,
        staleTime: 30 * 60 * 1000, // 30 minutes
        ...options,
    });
}

export function useToppings(options?: UseQueryOptions<Topping[]>) {
    return useQuery<Topping[]>({
        queryKey: catalogKeys.toppings(),
        queryFn: () => catalogApi.getToppings(),
        retry: 1,
        staleTime: 30 * 60 * 1000, // 30 minutes
        ...options,
    });
}

export function usePromos(options?: UseQueryOptions<Promo[]>) {
    return useQuery<Promo[]>({
        queryKey: catalogKeys.promos(),
        queryFn: () => catalogApi.getPromos(),
        retry: 1,
        staleTime: 10 * 60 * 1000, // 10 minutes
        ...options,
    });
}

// ============ CART HOOKS ============

export function useCreateCartSession(options?: UseMutationOptions<CartSession, unknown, CartItem[]>) {
    return useMutation<CartSession, unknown, CartItem[]>({
        mutationFn: (items) => cartApi.createSession(items),
        retry: false,
        ...options,
    });
}

// ============ ORDER HOOKS ============

export function useCheckout(options?: UseMutationOptions<Order, unknown, CreateOrderRequest>) {
    const queryClient = useQueryClient();

    return useMutation<Order, unknown, CreateOrderRequest>({
        mutationFn: (request) => checkoutApi.createOrder(request),
        onSuccess: (order) => {
            // Invalidate relevant queries
            queryClient.invalidateQueries({ queryKey: orderKeys.lists() });
        },
        retry: false,
        ...options,
    });
}

export function useValidateVoucher(
    options?: UseMutationOptions<ValidateVoucherResponse, unknown, ValidateVoucherRequest>
) {
    return useMutation<ValidateVoucherResponse, unknown, ValidateVoucherRequest>({
        mutationFn: (request) => checkoutApi.validateVoucher(request),
        retry: false,
        ...options,
    });
}

export function useUserOrders(userId: string, status?: string, options?: UseQueryOptions<Order[]>) {
    return useQuery<Order[]>({
        queryKey: orderKeys.list(userId, status),
        queryFn: () => ordersApi.getUserOrders(userId, status),
        enabled: !!userId,
        retry: 1,
        staleTime: 2 * 60 * 1000, // 2 minutes
        ...options,
    });
}

// ============ AUTH HOOKS ============

export function useLoginWithGoogle(options?: UseMutationOptions<AuthResponse, unknown, string>) {
    const queryClient = useQueryClient();

    return useMutation<AuthResponse, unknown, string>({
        mutationFn: (idToken) => authApi.loginWithGoogle(idToken),
        onSuccess: (data) => {
            const { user, tokens } = data;
            authApi.setTokens(tokens.accessToken, tokens.refreshToken);
            localStorage.setItem('user', JSON.stringify(user));
            queryClient.setQueryData(authKeys.me(), user);
        },
        retry: false,
        ...options,
    });
}

export function useLogout(options?: UseMutationOptions<void, unknown, void>) {
    const queryClient = useQueryClient();

    return useMutation<void, unknown, void>({
        mutationFn: async () => {
            authApi.clearTokens();
        },
        onSuccess: () => {
            queryClient.clear();
        },
        retry: false,
        ...options,
    });
}

export function useIsAuthenticated(): boolean {
    return authApi.isAuthenticated();
}
