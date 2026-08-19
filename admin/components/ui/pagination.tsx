import { cn } from '@/lib/utils';

export const PAGE_SIZE_OPTIONS = [10, 20, 50, 100] as const;

type PaginationProps = {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
  onPageChange: (page: number) => void;
  onLimitChange: (limit: number) => void;
  className?: string;
};

/**
 * Shared list-footer pagination: Previous / Next, current page + total pages,
 * total count, and a page-size selector. Server-driven — the parent owns
 * page/limit state and refetches on change.
 */
export function Pagination({
  page,
  limit,
  total,
  totalPages,
  onPageChange,
  onLimitChange,
  className,
}: PaginationProps) {
  const safeTotalPages = Math.max(1, totalPages);
  const from = total === 0 ? 0 : (page - 1) * limit + 1;
  const to = Math.min(total, page * limit);

  return (
    <div className={cn('mt-4 flex flex-col gap-3 border-t border-gray-100 pt-4 text-sm sm:flex-row sm:items-center sm:justify-between', className)}>
      <div className="flex items-center gap-3 text-gray-500">
        <span>
          {from}–{to} of {total}
        </span>
        <label className="flex items-center gap-2">
          <span className="text-xs uppercase text-gray-400">Per page</span>
          <select
            value={limit}
            onChange={(e) => onLimitChange(Number(e.target.value))}
            className="h-9 rounded-lg border border-gray-200 bg-white px-2 text-sm outline-none focus:border-[#465fff]"
          >
            {PAGE_SIZE_OPTIONS.map((size) => (
              <option key={size} value={size}>
                {size}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={() => onPageChange(page - 1)}
          disabled={page <= 1}
          className="rounded-lg px-3 py-1.5 text-sm font-medium text-gray-600 ring-1 ring-gray-200 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-40"
        >
          Previous
        </button>
        <span className="text-gray-500">
          Page {page} of {safeTotalPages}
        </span>
        <button
          type="button"
          onClick={() => onPageChange(page + 1)}
          disabled={page >= safeTotalPages}
          className="rounded-lg px-3 py-1.5 text-sm font-medium text-gray-600 ring-1 ring-gray-200 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-40"
        >
          Next
        </button>
      </div>
    </div>
  );
}
