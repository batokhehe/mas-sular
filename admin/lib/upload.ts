

import { getAuthToken } from './api';

export async function uploadImage(formData: FormData) {
    const token = getAuthToken();
    const headers: Record<string, string> = {};
    if (token) {
        headers.Authorization = `Bearer ${token}`;
    }

    const response = await fetch(
        `${process.env.NEXT_PUBLIC_API_URL}/upload`,
        {
            method: 'POST',
            headers,
            body: formData,
        }
    );

    if (!response.ok) {
        throw new Error('Failed to upload image');
    }

    return response.json();
}