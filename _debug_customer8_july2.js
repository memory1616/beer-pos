const db = require('./database');

const now = new Date();
const currentYear = now.getFullYear();
const currentMonth = String(now.getMonth() + 1).padStart(2, '0');

const active = db.prepare("SELECT id,date,type,archived,promo_type,promo_free_liters,deliver_kegs,return_kegs,total FROM sales WHERE customer_id=8 AND strftime('%Y-%m', date)=? AND archived=0 ORDER BY date ASC, id ASC").all(`${currentYear}-${currentMonth}`);
const archived = db.prepare("SELECT id,date,type,archived,promo_type,promo_free_liters,deliver_kegs,return_kegs,total FROM sales WHERE customer_id=8 AND strftime('%Y-%m', date)=? AND archived=1 ORDER BY date ASC, id ASC").all(`${currentYear}-${currentMonth}`);
console.log('ACTIVE_JULY', JSON.stringify(active, null, 2));
console.log('ARCHIVED_JULY', JSON.stringify(archived, null, 2));

const customer = db.prepare('SELECT first_order_date FROM customers WHERE id=?').get(8);
console.log('CUSTOMER_FIRST_ORDER_DATE', JSON.stringify(customer, null, 2));
