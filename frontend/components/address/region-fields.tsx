'use client'

import { useState } from 'react'
import { Label } from '@/components/ui/label'
import { Input } from '@/components/ui/input'
import { SearchableSelect, type SelectOption } from './searchable-select'
import { useCities, useDistricts, useProvinces, useVillages } from '@/lib/query/hooks/use-regions'
import type { RegionValue } from '@/lib/address/region-value'

export interface RegionFieldErrors {
  provinceId?: string
  cityId?: string
  districtId?: string
  villageId?: string
  postalCode?: string
}

interface Props {
  value: RegionValue
  onChange: (value: RegionValue) => void
  errors?: RegionFieldErrors
  disabled?: boolean
}

/**
 * Province → City/Regency → District → Village chain-select with auto-filled
 * postal code. Selecting a higher level cascades a reset of every lower level.
 * Loading is progressive: a level only fetches once its parent id exists.
 */
export function RegionFields({ value, onChange, errors, disabled }: Props) {
  const [provinceSearch, setProvinceSearch] = useState('')
  const [citySearch, setCitySearch] = useState('')
  const [districtSearch, setDistrictSearch] = useState('')
  const [villageSearch, setVillageSearch] = useState('')

  const provinces = useProvinces(provinceSearch)
  const cities = useCities(value.provinceId, citySearch)
  const districts = useDistricts(value.cityId, districtSearch)
  const villages = useVillages(value.districtId, villageSearch)

  const provinceOptions: SelectOption[] = (provinces.data ?? []).map((p) => ({ value: p.id, label: p.name }))
  const cityOptions: SelectOption[] = (cities.data ?? []).map((c) => ({ value: c.id, label: c.name }))
  const districtOptions: SelectOption[] = (districts.data ?? []).map((d) => ({ value: d.id, label: d.name }))
  const villageOptions: SelectOption[] = (villages.data ?? []).map((v) => ({
    value: v.id,
    label: v.name,
    hint: v.postalCode ?? undefined,
  }))

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label>Provinsi</Label>
          <SearchableSelect
            value={value.provinceId}
            selectedLabel={value.provinceName}
            options={provinceOptions}
            loading={provinces.isLoading}
            disabled={disabled}
            placeholder="Pilih provinsi"
            searchPlaceholder="Cari provinsi…"
            onSearchChange={setProvinceSearch}
            onChange={(id, opt) =>
              onChange({
                provinceId: id,
                provinceName: opt.label,
                cityId: undefined,
                cityName: undefined,
                districtId: undefined,
                districtName: undefined,
                villageId: undefined,
                villageName: undefined,
                postalCode: undefined,
              })
            }
          />
          {errors?.provinceId ? <p className="text-xs text-destructive">{errors.provinceId}</p> : null}
        </div>

        <div className="space-y-1.5">
          <Label>Kota / Kabupaten</Label>
          <SearchableSelect
            value={value.cityId}
            selectedLabel={value.cityName}
            options={cityOptions}
            loading={cities.isFetching}
            disabled={disabled || !value.provinceId}
            placeholder={value.provinceId ? 'Pilih kota/kabupaten' : 'Pilih provinsi dulu'}
            searchPlaceholder="Cari kota/kabupaten…"
            onSearchChange={setCitySearch}
            onChange={(id, opt) =>
              onChange({
                ...value,
                cityId: id,
                cityName: opt.label,
                districtId: undefined,
                districtName: undefined,
                villageId: undefined,
                villageName: undefined,
                postalCode: undefined,
              })
            }
          />
          {errors?.cityId ? <p className="text-xs text-destructive">{errors.cityId}</p> : null}
        </div>

        <div className="space-y-1.5">
          <Label>Kecamatan</Label>
          <SearchableSelect
            value={value.districtId}
            selectedLabel={value.districtName}
            options={districtOptions}
            loading={districts.isFetching}
            disabled={disabled || !value.cityId}
            placeholder={value.cityId ? 'Pilih kecamatan' : 'Pilih kota dulu'}
            searchPlaceholder="Cari kecamatan…"
            onSearchChange={setDistrictSearch}
            onChange={(id, opt) =>
              onChange({
                ...value,
                districtId: id,
                districtName: opt.label,
                villageId: undefined,
                villageName: undefined,
                postalCode: undefined,
              })
            }
          />
          {errors?.districtId ? <p className="text-xs text-destructive">{errors.districtId}</p> : null}
        </div>

        <div className="space-y-1.5">
          <Label>Kelurahan / Desa</Label>
          <SearchableSelect
            value={value.villageId}
            selectedLabel={value.villageName}
            options={villageOptions}
            loading={villages.isFetching}
            disabled={disabled || !value.districtId}
            placeholder={value.districtId ? 'Pilih kelurahan/desa' : 'Pilih kecamatan dulu'}
            searchPlaceholder="Cari kelurahan/desa…"
            onSearchChange={setVillageSearch}
            onChange={(id, opt) => {
              const picked = (villages.data ?? []).find((v) => v.id === id)
              onChange({
                ...value,
                villageId: id,
                villageName: opt.label,
                postalCode: picked?.postalCode ?? value.postalCode,
              })
            }}
          />
          {errors?.villageId ? <p className="text-xs text-destructive">{errors.villageId}</p> : null}
        </div>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="postalCode">Kode Pos</Label>
        <Input
          id="postalCode"
          value={value.postalCode ?? ''}
          readOnly
          placeholder="Terisi otomatis dari kelurahan"
          className="bg-muted/50"
        />
        {errors?.postalCode ? <p className="text-xs text-destructive">{errors.postalCode}</p> : null}
      </div>
    </div>
  )
}
