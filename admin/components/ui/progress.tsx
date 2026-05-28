export function Progress({ value }: { value: number }) {
  return (
    <div className="h-2 w-full overflow-hidden rounded-full bg-gray-100">
      <div className="h-full rounded-full bg-[#465fff]" style={{ width: `${Math.min(100, Math.max(0, value))}%` }} />
    </div>
  );
}
