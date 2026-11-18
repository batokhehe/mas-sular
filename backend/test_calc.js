const {OrdersService} = require('./src/modules/orders/orders.service');
const svc = new OrdersService({}, {}, {}, {}, undefined, undefined, undefined, undefined, undefined, undefined, undefined);
// Product percentage
let r = svc.calculateVoucherDiscountBreakdown({voucherType:'PERCENTAGE_DISCOUNT', discountPercentage:10, productDiscountType:null, shippingDiscountType:null}, 100000, 10000);
console.log('1:', JSON.stringify(r));
// Product fixed
r = svc.calculateVoucherDiscountBreakdown({voucherType:'FIXED_DISCOUNT', discountAmount:5000, productDiscountType:null, shippingDiscountType:null}, 100000, 10000);
console.log('2:', JSON.stringify(r));
// Shipping percentage
r = svc.calculateVoucherDiscountBreakdown({voucherType:'FREE_SHIPPING', shippingDiscountType:'PERCENTAGE', shippingDiscountPercentage:50, eligibleCouriers:['jne'], productDiscountType:null}, 100000, 10000, 'jne');
console.log('3:', JSON.stringify(r));
// Stacking
r = svc.calculateVoucherDiscountBreakdown({voucherType:'PERCENTAGE_DISCOUNT', productDiscountType:'PERCENTAGE', productDiscountPercentage:10, shippingDiscountType:'PERCENTAGE', shippingDiscountPercentage:20, eligibleCouriers:['jne']}, 100000, 10000, 'jne');
console.log('4:', JSON.stringify(r));
// Ineligible courier
r = svc.calculateVoucherDiscountBreakdown({voucherType:'PERCENTAGE_DISCOUNT', productDiscountType:'PERCENTAGE', productDiscountPercentage:10, shippingDiscountType:'PERCENTAGE', shippingDiscountPercentage:20, eligibleCouriers:['paxel']}, 100000, 10000, 'jne');
console.log('5:', JSON.stringify(r));
// Legacy free shipping
r = svc.calculateVoucherDiscountBreakdown({voucherType:'FREE_SHIPPING', freeShippingMaxAmount:5000}, 100000, 10000);
console.log('6:', JSON.stringify(r));
process.exit(0);
