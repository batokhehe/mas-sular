'use client'

import { motion } from 'framer-motion'
import { ChevronRight } from 'lucide-react'
import { Button } from '@/components/ui/button'
import Link from 'next/link'

export function HeroBanner() {
  return (
    <section className="relative overflow-hidden bg-gradient-to-br from-primary/10 via-background to-secondary/30">
      <div className="container py-8 sm:py-12 lg:py-16">
        <div className="grid gap-8 lg:grid-cols-2 lg:gap-12 items-center">
          {/* Content */}
          <motion.div
            initial={{ opacity: 0, x: -20 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ duration: 0.5 }}
            className="text-center lg:text-left"
          >
            <motion.div
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.2 }}
              className="inline-flex items-center gap-2 rounded-full bg-primary/10 px-4 py-1.5 text-sm font-medium text-primary mb-4"
            >
              <span className="relative flex h-2 w-2">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-primary opacity-75"></span>
                <span className="relative inline-flex rounded-full h-2 w-2 bg-primary"></span>
              </span>
              Promo Spesial Hari Ini
            </motion.div>

            <h1 className="text-3xl sm:text-4xl lg:text-5xl xl:text-6xl font-bold tracking-tight text-balance mb-4">
              Bakso Premium{' '}
              <span className="text-primary">Asli Nusantara</span>
            </h1>

            <p className="text-muted-foreground text-base sm:text-lg max-w-lg mx-auto lg:mx-0 mb-6">
              Nikmati kelezatan bakso berkualitas tinggi dengan daging sapi pilihan, 
              langsung diantar ke rumah Anda.
            </p>

            <div className="flex flex-col sm:flex-row gap-3 justify-center lg:justify-start">
              <Link href="/menu">
                <Button size="lg" className="rounded-full text-base w-full sm:w-auto">
                  Pesan Sekarang
                  <ChevronRight className="ml-1 h-4 w-4" />
                </Button>
              </Link>
              <Link href="/menu">
                <Button size="lg" variant="outline" className="rounded-full text-base w-full sm:w-auto">
                  Lihat Menu
                </Button>
              </Link>
            </div>

            {/* Stats */}
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.4 }}
              className="grid grid-cols-3 gap-4 mt-8 pt-8 border-t"
            >
              {[
                { value: '50K+', label: 'Pelanggan' },
                { value: '4.9', label: 'Rating' },
                { value: '30min', label: 'Pengiriman' },
              ].map((stat) => (
                <div key={stat.label} className="text-center lg:text-left">
                  <p className="text-2xl sm:text-3xl font-bold text-primary">{stat.value}</p>
                  <p className="text-xs sm:text-sm text-muted-foreground">{stat.label}</p>
                </div>
              ))}
            </motion.div>
          </motion.div>

          {/* Image */}
          <motion.div
            initial={{ opacity: 0, scale: 0.9 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ duration: 0.5, delay: 0.2 }}
            className="relative hidden lg:block"
          >
            <div className="relative aspect-square max-w-md mx-auto">
              {/* Decorative circles */}
              <div className="absolute inset-0 rounded-full bg-primary/5" />
              <div className="absolute inset-4 rounded-full bg-primary/10" />
              <div className="absolute inset-8 rounded-full bg-primary/5" />
              
              {/* Main image placeholder - bowl shape */}
              <div className="absolute inset-12 rounded-full bg-gradient-to-br from-primary/20 to-primary/5 flex items-center justify-center">
                <div className="text-center">
                  <div className="w-32 h-32 mx-auto rounded-full bg-primary/10 flex items-center justify-center mb-4">
                    <span className="text-6xl">🍜</span>
                  </div>
                  <p className="text-sm font-medium text-primary">Fresh Daily</p>
                </div>
              </div>

              {/* Floating elements */}
              <motion.div
                animate={{ y: [0, -10, 0] }}
                transition={{ duration: 3, repeat: Infinity }}
                className="absolute top-8 right-8 rounded-xl bg-card shadow-lg p-3"
              >
                <p className="text-xs font-medium">Diskon 20%</p>
                <p className="text-primary font-bold">Pengguna Baru</p>
              </motion.div>

              <motion.div
                animate={{ y: [0, 10, 0] }}
                transition={{ duration: 3, repeat: Infinity, delay: 1 }}
                className="absolute bottom-16 left-0 rounded-xl bg-card shadow-lg p-3"
              >
                <p className="text-xs font-medium">Gratis Ongkir</p>
                <p className="text-primary font-bold">Min. Rp100K</p>
              </motion.div>
            </div>
          </motion.div>
        </div>
      </div>

      {/* Background decoration */}
      <div className="absolute top-0 right-0 w-1/2 h-full bg-gradient-to-l from-primary/5 to-transparent pointer-events-none" />
    </section>
  )
}
