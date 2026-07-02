import { z } from 'zod'

export const addressSchema = z.object({
  label: z.string().min(1, 'Label is required'),
  recipientName: z.string().min(1, 'Recipient name is required'),
  phone: z.string().min(6, 'Enter a valid phone number'),
  // Street-level detail (house no, street, RT/RW). Kept as fullAddress for backward
  // compatibility and mirrored into addressDetail on submit.
  fullAddress: z.string().min(5, 'Alamat lengkap wajib diisi'),
  // Indonesian administrative hierarchy — required in the new form.
  provinceId: z.string().min(1, 'Provinsi wajib dipilih'),
  cityId: z.string().min(1, 'Kota/Kabupaten wajib dipilih'),
  districtId: z.string().min(1, 'Kecamatan wajib dipilih'),
  villageId: z.string().min(1, 'Kelurahan/Desa wajib dipilih'),
  postalCode: z.string().regex(/^\d{5}$/, 'Kode pos terisi otomatis dari kelurahan'),
  latitude: z.coerce.number(),
  longitude: z.coerce.number(),
  isDefault: z.boolean().optional(),
  notes: z.string().optional(),
})

export type AddressForm = z.infer<typeof addressSchema>
