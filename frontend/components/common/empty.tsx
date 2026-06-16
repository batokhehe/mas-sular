import { type ReactNode } from 'react'
import { Inbox } from 'lucide-react'

interface EmptyProps {
  title: string
  description?: string
  icon?: ReactNode
  action?: ReactNode
}

export function Empty({ title, description, icon, action }: EmptyProps) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 py-16 text-center">
      <div className="text-muted-foreground">{icon ?? <Inbox className="size-10" />}</div>
      <h3 className="text-lg font-semibold">{title}</h3>
      {description ? <p className="max-w-sm text-sm text-muted-foreground">{description}</p> : null}
      {action}
    </div>
  )
}
