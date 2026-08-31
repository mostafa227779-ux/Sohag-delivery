const http = require('http');
const crypto = require('crypto');
const { readDb, writeDb, genId } = require('./db');

const PORT = process.env.PORT || 3001;
const DELIVERY_FEE = 15;

// تشفير الباسورد بطريقة آمنة (scrypt) - مفيش تخزين نص عادي خالص
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  if (!stored || !stored.includes(':')) return false;
  const [salt, hash] = stored.split(':');
  const candidateHash = crypto.scryptSync(password, salt, 64).toString('hex');
  const hashBuffer = Buffer.from(hash, 'hex');
  const candidateBuffer = Buffer.from(candidateHash, 'hex');
  if (hashBuffer.length !== candidateBuffer.length) return false;
  return crypto.timingSafeEqual(hashBuffer, candidateBuffer);
}

// حالة الطلب دلوقتي بتتحكم فيها أفعال حقيقية: المحل بيأكد التجهيز، وبعدين المندوب بيتابع التسليم
function computeCustomerStatus(order) {
  if (order.courierId) {
    if (order.courierStage === 'delivered') return 'delivered';
    if (order.courierStage === 'on_the_way') return 'on_the_way';
    if (order.courierStage === 'picked_up') return 'on_the_way';
  }
  if (order.storeStatus === 'ready') return 'preparing';
  if (order.storeStatus === 'preparing') return 'preparing';
  return 'confirmed';
}

function send(res, status, body) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => (data += chunk));
    req.on('end', () => {
      if (!data) return resolve({});
      try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
    });
  });
}

function withStatus(order) {
  return { ...order, status: computeCustomerStatus(order) };
}

function publicStore(store) {
  const { password, ...rest } = store;
  return rest;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const parts = url.pathname.split('/').filter(Boolean); // ['api', ...]

  if (req.method === 'OPTIONS') return send(res, 204, {});

  try {
    const db = readDb();

    // GET /api/categories
    if (req.method === 'GET' && parts[0] === 'api' && parts[1] === 'categories') {
      return send(res, 200, db.categories);
    }

    // GET /api/stores?categoryId=xxx
    if (req.method === 'GET' && parts[0] === 'api' && parts[1] === 'stores' && parts.length === 2) {
      const categoryId = url.searchParams.get('categoryId');
      let stores = db.stores;
      if (categoryId) stores = stores.filter(s => s.categoryId === categoryId);
      return send(res, 200, stores.map(publicStore));
    }

    // GET /api/stores/:id
    if (req.method === 'GET' && parts[0] === 'api' && parts[1] === 'stores' && parts.length === 3) {
      const store = db.stores.find(s => s.id === parts[2]);
      if (!store) return send(res, 404, { error: 'المحل غير موجود' });
      return send(res, 200, publicStore(store));
    }

    // GET /api/stores/:id/products  (للعميل - بيرجع بس المنتجات المتاحة)
    if (req.method === 'GET' && parts[0] === 'api' && parts[1] === 'stores' && parts[3] === 'products') {
      const products = db.products.filter(p => p.storeId === parts[2] && p.available !== false);
      return send(res, 200, products);
    }

    // POST /api/auth/login  { phone, name }
    if (req.method === 'POST' && parts[0] === 'api' && parts[1] === 'auth' && parts[2] === 'login') {
      const body = await readBody(req);
      if (!body.phone) return send(res, 400, { error: 'رقم الموبايل مطلوب' });
      let user = db.users.find(u => u.phone === body.phone);
      if (!user) {
        user = { id: genId('user'), phone: body.phone, name: body.name || '', addresses: [] };
        db.users.push(user);
        writeDb(db);
      }
      return send(res, 200, user);
    }

    // POST /api/orders  { userPhone, address, storeId, items:[{productId, quantity}], paymentMethod }
    if (req.method === 'POST' && parts[0] === 'api' && parts[1] === 'orders' && parts.length === 2) {
      const body = await readBody(req);
      const { userPhone, address, storeId, items, paymentMethod } = body;

      if (!userPhone || !address || !storeId || !Array.isArray(items) || items.length === 0) {
        return send(res, 400, { error: 'بيانات الطلب ناقصة' });
      }

      const store = db.stores.find(s => s.id === storeId);
      if (!store) return send(res, 400, { error: 'المحل غير موجود' });

      let subtotal = 0;
      const orderItems = items.map(item => {
        const product = db.products.find(p => p.id === item.productId);
        if (!product) throw new Error('منتج غير موجود: ' + item.productId);
        const lineTotal = product.price * item.quantity;
        subtotal += lineTotal;
        return {
          productId: product.id,
          name: product.name,
          unit: product.unit,
          price: product.price,
          quantity: item.quantity
        };
      });

      const order = {
        id: genId('order'),
        userPhone,
        address,
        storeId,
        storeName: store.name,
        items: orderItems,
        subtotal,
        deliveryFee: DELIVERY_FEE,
        total: subtotal + DELIVERY_FEE,
        paymentMethod: paymentMethod || 'cash',
        storeStatus: 'new',
        courierId: null,
        courierName: null,
        courierVehicle: null,
        courierPlate: null,
        courierStage: null,
        createdAt: new Date().toISOString()
      };

      db.orders.push(order);
      writeDb(db);
      return send(res, 201, withStatus(order));
    }

    // GET /api/orders/:id
    if (req.method === 'GET' && parts[0] === 'api' && parts[1] === 'orders' && parts.length === 3) {
      const order = db.orders.find(o => o.id === parts[2]);
      if (!order) return send(res, 404, { error: 'الطلب غير موجود' });
      return send(res, 200, withStatus(order));
    }

    // GET /api/orders?userPhone=xxx
    if (req.method === 'GET' && parts[0] === 'api' && parts[1] === 'orders' && parts.length === 2) {
      const userPhone = url.searchParams.get('userPhone');
      let orders = db.orders;
      if (userPhone) orders = orders.filter(o => o.userPhone === userPhone);
      return send(res, 200, orders.map(withStatus).reverse());
    }

    // POST /api/categories  { name, icon }  -> إضافة قسم رئيسي جديد (زي "مخابز" أو "أدوات منزلية")
    if (req.method === 'POST' && parts[0] === 'api' && parts[1] === 'categories') {
      const body = await readBody(req);
      if (!body.name) return send(res, 400, { error: 'اسم القسم مطلوب' });
      const category = { id: genId('cat'), name: body.name, icon: body.icon || 'shopping-cart' };
      db.categories.push(category);
      writeDb(db);
      return send(res, 201, category);
    }

    // POST /api/stores  { name, categoryId, address, deliveryTimeMin, deliveryTimeMax, password }  -> تسجيل محل جديد
    if (req.method === 'POST' && parts[0] === 'api' && parts[1] === 'stores' && parts.length === 2) {
      const body = await readBody(req);
      if (!body.name || !body.categoryId) return send(res, 400, { error: 'اسم المحل والفئة مطلوبين' });
      if (!body.password || body.password.length < 4) return send(res, 400, { error: 'الباسورد لازم يكون 4 حروف أو أرقام على الأقل' });
      const category = db.categories.find(c => c.id === body.categoryId);
      if (!category) return send(res, 400, { error: 'الفئة غير موجودة' });
      if (db.stores.some(s => s.name === body.name)) return send(res, 409, { error: 'فيه محل بنفس الاسم ده بالفعل' });

      const store = {
        id: genId('store'),
        name: body.name,
        categoryId: body.categoryId,
        address: body.address || '',
        rating: 5,
        deliveryTimeMin: Number(body.deliveryTimeMin) || 15,
        deliveryTimeMax: Number(body.deliveryTimeMax) || 30,
        password: hashPassword(body.password)
      };
      db.stores.push(store);
      writeDb(db);
      return send(res, 201, publicStore(store));
    }

    // POST /api/store/login  { storeId, password }  -> تسجيل دخول صاحب المحل
    if (req.method === 'POST' && parts[0] === 'api' && parts[1] === 'store' && parts[2] === 'login') {
      const body = await readBody(req);
      const store = db.stores.find(s => s.id === body.storeId);
      if (!store) return send(res, 404, { error: 'المحل غير موجود' });
      if (!verifyPassword(body.password, store.password)) return send(res, 401, { error: 'الباسورد غلط' });
      return send(res, 200, publicStore(store));
    }

    // ================== نقاط اتصال لوحة تحكم المحل ==================

    // GET /api/store/:storeId/orders -> طلبات المحل ده (جديدة، بتتجهز، جاهزة، وآخر الطلبات المتسلمة)
    if (req.method === 'GET' && parts[0] === 'api' && parts[1] === 'store' && parts[3] === 'orders') {
      const storeId = parts[2];
      const orders = db.orders.filter(o => o.storeId === storeId);
      return send(res, 200, orders.map(withStatus).reverse());
    }

    // POST /api/store/orders/:id/status  { status: 'preparing' | 'ready' }
    if (req.method === 'POST' && parts[0] === 'api' && parts[1] === 'store' && parts[2] === 'orders' && parts[4] === 'status') {
      const orderId = parts[3];
      const body = await readBody(req);
      const order = db.orders.find(o => o.id === orderId);
      if (!order) return send(res, 404, { error: 'الطلب غير موجود' });
      if (!['preparing', 'ready'].includes(body.status)) return send(res, 400, { error: 'حالة غير صحيحة' });
      order.storeStatus = body.status;
      writeDb(db);
      return send(res, 200, withStatus(order));
    }

    // GET /api/store/:storeId/stats -> إحصائيات مبيعات اليوم
    if (req.method === 'GET' && parts[0] === 'api' && parts[1] === 'store' && parts[3] === 'stats') {
      const storeId = parts[2];
      const today = new Date().toDateString();
      const todayOrders = db.orders.filter(o => o.storeId === storeId && new Date(o.createdAt).toDateString() === today);
      const sales = todayOrders.reduce((sum, o) => sum + o.subtotal, 0);
      return send(res, 200, { ordersToday: todayOrders.length, salesToday: sales });
    }

    // GET /api/store/:storeId/products  (للوحة تحكم المحل - بيرجع كل المنتجات حتى الغير متاحة)
    if (req.method === 'GET' && parts[0] === 'api' && parts[1] === 'store' && parts[3] === 'products' && parts.length === 4) {
      const products = db.products.filter(p => p.storeId === parts[2]);
      return send(res, 200, products);
    }

    // POST /api/store/:storeId/products  { name, unit, price, icon }  -> إضافة منتج جديد
    if (req.method === 'POST' && parts[0] === 'api' && parts[1] === 'store' && parts[3] === 'products' && parts.length === 4) {
      const storeId = parts[2];
      const body = await readBody(req);
      if (!body.name || !body.price) return send(res, 400, { error: 'اسم المنتج والسعر مطلوبين' });
      const product = {
        id: genId('p'),
        storeId,
        name: body.name,
        unit: body.unit || 'قطعة',
        price: Number(body.price),
        icon: body.icon || 'shopping-cart',
        image: body.image || null,
        subCategory: body.subCategory || 'عام',
        available: true
      };
      db.products.push(product);
      writeDb(db);
      return send(res, 201, product);
    }

    // POST /api/store/products/:id  { name?, unit?, price?, available? }  -> تعديل منتج موجود
    if (req.method === 'POST' && parts[0] === 'api' && parts[1] === 'store' && parts[2] === 'products' && parts.length === 4) {
      const productId = parts[3];
      const body = await readBody(req);
      const product = db.products.find(p => p.id === productId);
      if (!product) return send(res, 404, { error: 'المنتج غير موجود' });
      if (body.name !== undefined) product.name = body.name;
      if (body.unit !== undefined) product.unit = body.unit;
      if (body.price !== undefined) product.price = Number(body.price);
      if (body.available !== undefined) product.available = body.available;
      if (body.image !== undefined) product.image = body.image;
      if (body.subCategory !== undefined) product.subCategory = body.subCategory;
      writeDb(db);
      return send(res, 200, product);
    }

    // ================== نقاط اتصال المندوب ==================

    // GET /api/courier/orders  -> الطلبات المتاحة (لازم المحل يكون جهزها الأول)
    if (req.method === 'GET' && parts[0] === 'api' && parts[1] === 'courier' && parts[2] === 'orders' && parts.length === 3) {
      const available = db.orders.filter(o => !o.courierId && o.storeStatus === 'ready');
      return send(res, 200, available.map(withStatus));
    }

    // GET /api/courier/mine?courierId=xxx  -> الطلب النشط الحالي للمندوب ده (لو فيه)
    if (req.method === 'GET' && parts[0] === 'api' && parts[1] === 'courier' && parts[2] === 'mine') {
      const courierId = url.searchParams.get('courierId');
      const active = db.orders.find(o => o.courierId === courierId && o.courierStage !== 'delivered');
      if (!active) return send(res, 200, null);
      return send(res, 200, withStatus(active));
    }

    // POST /api/courier/orders/:id/accept  { courierId, courierName, courierVehicle, courierPlate }
    if (req.method === 'POST' && parts[0] === 'api' && parts[1] === 'courier' && parts[2] === 'orders' && parts[4] === 'accept') {
      const orderId = parts[3];
      const body = await readBody(req);
      const order = db.orders.find(o => o.id === orderId);
      if (!order) return send(res, 404, { error: 'الطلب غير موجود' });
      if (order.courierId) return send(res, 409, { error: 'الطلب اتقبل بالفعل من مندوب تاني' });

      order.courierId = body.courierId || 'courier-1';
      order.courierName = body.courierName || 'أحمد المندوب';
      order.courierVehicle = body.courierVehicle || 'موتوسيكل';
      order.courierPlate = body.courierPlate || '66421';
      order.courierStage = 'picked_up';
      writeDb(db);
      return send(res, 200, withStatus(order));
    }

    // POST /api/courier/orders/:id/stage  { stage: 'on_the_way' | 'delivered' }
    if (req.method === 'POST' && parts[0] === 'api' && parts[1] === 'courier' && parts[2] === 'orders' && parts[4] === 'stage') {
      const orderId = parts[3];
      const body = await readBody(req);
      const order = db.orders.find(o => o.id === orderId);
      if (!order) return send(res, 404, { error: 'الطلب غير موجود' });
      if (!['picked_up', 'on_the_way', 'delivered'].includes(body.stage)) {
        return send(res, 400, { error: 'حالة غير صحيحة' });
      }
      order.courierStage = body.stage;
      writeDb(db);
      return send(res, 200, withStatus(order));
    }

    // GET /api/courier/stats?courierId=xxx  -> إحصائيات اليوم
    if (req.method === 'GET' && parts[0] === 'api' && parts[1] === 'courier' && parts[2] === 'stats') {
      const courierId = url.searchParams.get('courierId');
      const today = new Date().toDateString();
      const delivered = db.orders.filter(o =>
        o.courierId === courierId &&
        o.courierStage === 'delivered' &&
        new Date(o.createdAt).toDateString() === today
      );
      const earnings = delivered.reduce((sum, o) => sum + o.deliveryFee, 0);
      return send(res, 200, { ordersToday: delivered.length, earningsToday: earnings });
    }

    return send(res, 404, { error: 'المسار غير موجود' });
  } catch (err) {
    return send(res, 500, { error: err.message });
  }
});

server.listen(PORT, () => {
  console.log(`souhag-delivery API running on http://localhost:${PORT}`);
});
