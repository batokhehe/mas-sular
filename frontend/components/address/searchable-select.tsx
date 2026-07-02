'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { Check, ChevronsUpDown, Loader2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'

export interface SelectOption {
  value: string
  label: string
  hint?: string
}

interface Props {
  value?: string
  /** Human label for the currently-selected value (needed when the option isn't in the current page). */
  selectedLabel?: string
  onChange: (value: string, option: SelectOption) => void
  options: SelectOption[]
  loading?: boolean
  disabled?: boolean
  placeholder?: string
  searchPlaceholder?: string
  emptyText?: string
  /** Called (debounced 300ms) as the user types, for server-side search. */
  onSearchChange?: (search: string) => void
  className?: string
  id?: string
}

/**
 * Debounced, searchable single-select combobox used for every level of the
 * Indonesian address chain. Server-side search (cmdk's own filtering is disabled),
 * 300ms debounce, a loading spinner, and a "No data found" empty state.
 */
export function SearchableSelect({
  value,
  selectedLabel,
  onChange,
  options,
  loading,
  disabled,
  placeholder = 'Select…',
  searchPlaceholder = 'Search…',
  emptyText = 'No data found',
  onSearchChange,
  className,
  id,
}: Props) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')

  // 300ms debounce → notify parent to refetch with the new search term.
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    if (!onSearchChange) return
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => onSearchChange(query.trim()), 300)
    return () => {
      if (timer.current) clearTimeout(timer.current)
    }
  }, [query, onSearchChange])

  const currentLabel = useMemo(() => {
    if (!value) return ''
    return options.find((o) => o.value === value)?.label ?? selectedLabel ?? ''
  }, [value, options, selectedLabel])

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (!next) setQuery('')
      }}
    >
      <PopoverTrigger asChild>
        <Button
          id={id}
          type="button"
          variant="outline"
          role="combobox"
          aria-expanded={open}
          disabled={disabled}
          className={cn('w-full justify-between font-normal', !currentLabel && 'text-muted-foreground', className)}
        >
          <span className="truncate">{currentLabel || placeholder}</span>
          <ChevronsUpDown className="ml-2 size-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[--radix-popover-trigger-width] p-0" align="start">
        <Command shouldFilter={false}>
          <CommandInput placeholder={searchPlaceholder} value={query} onValueChange={setQuery} />
          <CommandList>
            {loading ? (
              <div className="flex items-center justify-center gap-2 py-6 text-sm text-muted-foreground">
                <Loader2 className="size-4 animate-spin" /> Loading…
              </div>
            ) : (
              <>
                <CommandEmpty>{emptyText}</CommandEmpty>
                <CommandGroup>
                  {options.map((option) => (
                    <CommandItem
                      key={option.value}
                      value={option.value}
                      onSelect={() => {
                        onChange(option.value, option)
                        setOpen(false)
                        setQuery('')
                      }}
                    >
                      <Check
                        className={cn('mr-2 size-4', value === option.value ? 'opacity-100' : 'opacity-0')}
                      />
                      <span className="flex-1 truncate">{option.label}</span>
                      {option.hint ? (
                        <span className="ml-2 shrink-0 text-xs text-muted-foreground">{option.hint}</span>
                      ) : null}
                    </CommandItem>
                  ))}
                </CommandGroup>
              </>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}
