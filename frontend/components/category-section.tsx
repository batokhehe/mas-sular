'use client'

import { motion } from 'framer-motion'
import Link from 'next/link'
import { useCategories } from '@/hooks/api'
import { cn } from '@/lib/utils'

interface CategorySectionProps {
  selectedCategory?: string
  onSelectCategory?: (slug: string | null) => void
}

export function CategorySection({ selectedCategory, onSelectCategory }: CategorySectionProps) {
  const { data: categories = [] } = useCategories()

  const handleClick = (slug: string) => {
    if (onSelectCategory) {
      onSelectCategory(selectedCategory === slug ? null : slug)
    }
  }

  return (
    <section className="py-6">
      <div className="container">
        <h2 className="text-lg sm:text-xl font-bold mb-4">Kategori</h2>
        <div className="flex gap-3 overflow-x-auto pb-2 scrollbar-hide -mx-4 px-4 sm:mx-0 sm:px-0">
          {categories.map((category, index) => {
            const isSelected = selectedCategory === category.slug
            
            if (onSelectCategory) {
              return (
                <motion.button
                  key={category.id}
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: index * 0.05 }}
                  onClick={() => handleClick(category.slug)}
                  className={cn(
                    'flex flex-col items-center gap-2 min-w-[80px] p-3 rounded-2xl transition-all shrink-0',
                    isSelected
                      ? 'bg-primary text-primary-foreground shadow-lg shadow-primary/25'
                      : 'bg-card border hover:border-primary/50 hover:shadow-md'
                  )}
                >
                  <span className="text-2xl">{category.icon || '📦'}</span>
                  <span className="text-xs font-medium whitespace-nowrap">{category.name}</span>
                </motion.button>
              )
            }

            return (
              <Link key={category.id} href={`/menu?category=${category.slug}`}>
                <motion.div
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: index * 0.05 }}
                  whileHover={{ y: -2 }}
                  className="flex flex-col items-center gap-2 min-w-[80px] p-3 rounded-2xl bg-card border hover:border-primary/50 hover:shadow-md transition-all shrink-0"
                >
                  <span className="text-2xl">{category.icon || '📦'}</span>
                  <span className="text-xs font-medium whitespace-nowrap">{category.name}</span>
                </motion.div>
              </Link>
            )
          })}
        </div>
      </div>
    </section>
  )
}
