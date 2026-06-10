type ProductImageSource = {
  image?: string | null
  imageUrl?: string | null
}

const fallbackProductImage = '/placeholder.jpg'

function getApiOrigin() {
  const apiUrl = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3333/api/v1'

  try {
    return new URL(apiUrl).origin
  } catch {
    return 'http://localhost:3333'
  }
}

export function getProductImageSrc(product?: ProductImageSource | null) {
  const rawImage = product?.imageUrl || product?.image

  if (!rawImage) {
    return fallbackProductImage
  }

  if (
    rawImage.startsWith('http://') ||
    rawImage.startsWith('https://') ||
    rawImage.startsWith('data:') ||
    rawImage.startsWith('blob:')
  ) {
    return rawImage
  }

  if (rawImage.startsWith('/uploads/')) {
    return `${getApiOrigin()}${rawImage}`
  }

  if (rawImage.startsWith('uploads/')) {
    return `${getApiOrigin()}/${rawImage}`
  }

  return rawImage.startsWith('/') ? rawImage : `/${rawImage}`
}
