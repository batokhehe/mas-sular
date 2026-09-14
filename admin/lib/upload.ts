import { apiBaseUrl, csrfHeaders } from './api';

/** Catalogue/banner image upload. Authenticated by the httpOnly admin session cookie (H4). */
export async function uploadImage(formData: FormData) {
    const response = await fetch(
        `${apiBaseUrl()}/upload`,
        {
            method: 'POST',
            credentials: 'include',
            headers: await csrfHeaders('POST'),
            body: formData,
        }
    );

    if (!response.ok) {
        throw new Error('Failed to upload image');
    }

    return response.json();
}
