'use client'

import { useEffect, useState } from 'react'
import { CheckCircle2, Loader2, Upload } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useUploadReceipt } from '@/lib/query/hooks/use-upload-receipt'

interface UploadReceiptProps {
  mode: 'token' | 'auth'
  /** token (mode='token') or paymentId (mode='auth') */
  reference: string
  onUploaded?: () => void
}

export function UploadReceipt({ mode, reference, onUploaded }: UploadReceiptProps) {
  const [file, setFile] = useState<File | null>(null)
  const [preview, setPreview] = useState<string | null>(null)
  const [bankName, setBankName] = useState('')
  const [accountName, setAccountName] = useState('')
  const mutation = useUploadReceipt(mode, reference)

  useEffect(() => {
    if (!file) {
      setPreview(null)
      return
    }
    const url = URL.createObjectURL(file)
    setPreview(url)
    return () => URL.revokeObjectURL(url)
  }, [file])

  if (mutation.isSuccess) {
    return (
      <div className="flex flex-col items-center gap-2 rounded-lg border border-green-200 bg-green-50 p-6 text-center">
        <CheckCircle2 className="size-8 text-green-600" />
        <p className="font-semibold">Receipt submitted</p>
        <p className="text-sm text-muted-foreground">Your payment is now under review.</p>
      </div>
    )
  }

  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault()
        if (!file) return
        mutation.mutate(
          { file, bankName: bankName || undefined, accountName: accountName || undefined },
          { onSuccess: () => onUploaded?.() },
        )
      }}
    >
      <div className="space-y-2">
        <Label htmlFor="receipt">Payment receipt (image)</Label>
        <Input
          id="receipt"
          type="file"
          accept="image/jpeg,image/png,image/webp"
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
        />
      </div>

      {preview ? (
        <div className="overflow-hidden rounded-lg border">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={preview} alt="Receipt preview" className="max-h-64 w-full object-contain" />
        </div>
      ) : null}

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor="bankName">Bank name (optional)</Label>
          <Input id="bankName" value={bankName} onChange={(e) => setBankName(e.target.value)} />
        </div>
        <div className="space-y-2">
          <Label htmlFor="accountName">Account name (optional)</Label>
          <Input id="accountName" value={accountName} onChange={(e) => setAccountName(e.target.value)} />
        </div>
      </div>

      <Button type="submit" className="w-full" disabled={!file || mutation.isPending}>
        {mutation.isPending ? (
          <>
            <Loader2 className="mr-2 size-4 animate-spin" /> Uploading…
          </>
        ) : (
          <>
            <Upload className="mr-2 size-4" /> Submit receipt
          </>
        )}
      </Button>
    </form>
  )
}
