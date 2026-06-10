

export async function uploadImage(formData: FormData) {
    const response = await fetch(
        `${process.env.NEXT_PUBLIC_API_URL}/upload`,
        {
            method: 'POST',
            body: formData,
        }
    );

    if (!response.ok) {
        throw new Error('Failed to upload image');
    }

    return response.json();
}