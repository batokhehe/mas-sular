const fs=require('fs');
console.log(fs.readFileSync('backend/src/modules/invoices/invoice-view.ts','utf8').includes('voucherDiscountAmount'));
console.log(fs.readFileSync('backend/src/modules/orders/orders.service.ts','utf8').includes('voucherDiscountAmount'));
console.log(fs.readFileSync('admin/app/orders/[id]/page.tsx','utf8').includes('voucherDiscountAmount'));
console.log(fs.readFileSync('frontend/app/orders/page.tsx','utf8').includes('voucherDiscountAmount'));
console.log(fs.readFileSync('frontend/lib/checkout/summary.ts','utf8').includes('voucherDiscountAmount'));
console.log(fs.readFileSync('backend/src/modules/orders/domain/customer-order-view.ts','utf8').includes('voucherDiscountAmount'));
console.log(fs.readFileSync('frontend/lib/types/models.ts','utf8').includes('voucherDiscountAmount'));
