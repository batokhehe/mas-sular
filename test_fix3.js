const Module = require('module');
const origRequire = Module.prototype.require;
Module.prototype.require = function(name) {
  if (name === '@nestjs/common') {
    return {
      Injectable: () => (target) => target,
      BadRequestException: class BadRequestException extends Error { constructor(m){super(m); this.name='BadRequestException';} },
      NotFoundException: class NotFoundException extends Error { constructor(m){super(m); this.name='NotFoundException';} },
    };
  }
  return origRequire.apply(this, arguments);
};
const {AdminService} = require('./backend/src/modules/admin/admin.service');

// Test shipping removal
const prisma1 = { promo: { findUnique: async ()=>({id:'p1', shippingDiscountType:'PERCENTAGE', shippingDiscountPercentage:50, shippingDiscountAmount:null, shippingMaxDiscountAmount:null, eligibleCouriers:['jne'], productDiscountType:null}), update: async (args)=>({payload: args.data}) } };
const svc1 = new AdminService(prisma1);
svc1.updatePromo('p1', {shippingDiscountType: null}).then(r=>{
  console.log('shipping_removal:', JSON.stringify(r.payload));
  // Test product removal
  const prisma2 = { promo: { findUnique: async ()=>({id:'p2', productDiscountType:'PERCENTAGE', productDiscountPercentage:10, productDiscountAmount:null, productMaxDiscountAmount:null, shippingDiscountType:null}), update: async (args)=>({payload: args.data}) } };
  const svc2 = new AdminService(prisma2);
  return svc2.updatePromo('p2', {productDiscountType: null});
}).then(r=>{
  console.log('product_removal:', JSON.stringify(r.payload));
  // Test updating shipping amount preserves couriers
  const prisma3 = { promo: { findUnique: async ()=>({id:'p3', shippingDiscountType:'PERCENTAGE', shippingDiscountPercentage:50, shippingDiscountAmount:null, shippingMaxDiscountAmount:null, eligibleCouriers:['jne','paxel']}), update: async (args)=>({payload: args.data}) } };
  const svc3 = new AdminService(prisma3);
  return svc3.updatePromo('p3', {shippingDiscountPercentage: 30});
}).then(r=>{
  console.log('update_shipping_preserves_couriers:', JSON.stringify(r.payload));
  process.exit(0);
}).catch(e=>{
  console.log('ERR'); console.log(e.message);
  process.exit(1);
});
