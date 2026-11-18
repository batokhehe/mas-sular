const {AdminService} = require('./backend/src/modules/admin/admin.service');
const p = { promo: { findUnique: async ()=>({id:'p1', shippingDiscountType:'PERCENTAGE', shippingDiscountPercentage:50, eligibleCouriers:['jne'], productDiscountType:null}), update: async (a)=>({d: a.data}) } };
const s = new AdminService(p);
s.updatePromo('p1', {shippingDiscountType: null}).then(r=>{
  console.log(JSON.stringify(r.d));
  process.exit(0);
}).catch(e=>{
  console.log('ERR');
  process.exit(1);
});
