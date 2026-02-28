const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(helmet());
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Rate limiting
const limiter = rateLimit({
  windowMs: 24 * 60 * 60 * 1000,
  max: 100,
  message: { error: 'Rate limit exceeded' }
});
app.use(limiter);

// Admin rate limiter
const adminLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 50,
  message: { error: 'Admin rate limit exceeded' }
});

// Data paths
const DATA_DIR = path.join(__dirname, 'data');
const PRODUCTS_FILE = path.join(DATA_DIR, 'products.json');
const SUPPLIERS_FILE = path.join(DATA_DIR, 'suppliers.json');
const VENDORS_FILE = path.join(DATA_DIR, 'vendors.json');
const WEBHOOK_LOG_FILE = path.join(DATA_DIR, 'webhook_logs.json');

// Ensure data files exist
function ensureDataFiles() {
  [PRODUCTS_FILE, SUPPLIERS_FILE, VENDORS_FILE, WEBHOOK_LOG_FILE].forEach(file => {
    if (!fs.existsSync(file)) {
      fs.writeFileSync(file, JSON.stringify([], null, 2));
    }
  });
}
ensureDataFiles();

// Data access functions
const loadJSON = (file) => {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return []; }
};
const saveJSON = (file, data) => fs.writeFileSync(file, JSON.stringify(data, null, 2));

const loadProducts = () => loadJSON(PRODUCTS_FILE);
const saveProducts = (data) => saveJSON(PRODUCTS_FILE, data);
const loadSuppliers = () => loadJSON(SUPPLIERS_FILE);
const saveSuppliers = (data) => saveJSON(SUPPLIERS_FILE, data);
const loadVendors = () => loadJSON(VENDORS_FILE);
const saveVendors = (data) => saveJSON(VENDORS_FILE, data);
const loadWebhookLogs = () => loadJSON(WEBHOOK_LOG_FILE);
const saveWebhookLogs = (data) => saveJSON(WEBHOOK_LOG_FILE, data);

// Generate IDs and keys
const generateId = () => crypto.randomUUID();
const generateSupplierKey = (name) => 'supp_' + name.toLowerCase().replace(/[^a-z0-9]/g, '_') + '_' + crypto.randomBytes(8).toString('hex');
const generateVendorKey = () => 'vnd_' + crypto.randomBytes(32).toString('hex');

// Auth middleware
const getApiKey = (req) => req.headers['x-api-key'] || req.query.api_key;

const requireAuth = (req, res, next) => {
  const key = getApiKey(req);
  if (!key) return res.status(401).json({ error: 'API key required' });
  req.apiKey = key;
  next();
};

const requireAdmin = (req, res, next) => {
  const key = getApiKey(req);
  if (key !== process.env.ADMIN_KEY) {
    return res.status(403).json({ error: 'Admin access required' });
  }
  req.isAdmin = true;
  next();
};

const requireSupplier = (req, res, next) => {
  const key = getApiKey(req);
  const suppliers = loadSuppliers();
  const supplier = suppliers.find(s => s.api_key === key);
  
  if (!supplier && key !== process.env.ADMIN_KEY) {
    return res.status(403).json({ error: 'Invalid supplier key' });
  }
  
  req.supplier = supplier;
  req.isAdmin = key === process.env.ADMIN_KEY;
  next();
};

// ============================================
// WEBHOOK SYSTEM
// ============================================

// Deliver webhook to vendor
async function deliverWebhook(vendor, payload) {
  const logEntry = {
    id: generateId(),
    vendor_id: vendor.id,
    webhook_url: vendor.webhook_url,
    event_type: payload.event_type,
    payload: payload,
    status: 'pending',
    created_at: new Date().toISOString(),
    delivered_at: null,
    error: null,
    retry_count: 0
  };

  const logs = loadWebhookLogs();
  logs.push(logEntry);
  saveWebhookLogs(logs);

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);

    const response = await fetch(vendor.webhook_url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Webhook-Secret': vendor.api_key,
        'X-Event-Type': payload.event_type,
        'User-Agent': 'BelgianRoofingAPI/2.0'
      },
      body: JSON.stringify(payload),
      signal: controller.signal
    });

    clearTimeout(timeout);

    logEntry.status = response.ok ? 'delivered' : 'failed';
    logEntry.http_status = response.status;
    logEntry.delivered_at = new Date().toISOString();
    
    if (!response.ok) {
      logEntry.error = `HTTP ${response.status}`;
    }
  } catch (error) {
    logEntry.status = 'failed';
    logEntry.error = error.name === 'AbortError' ? 'Timeout' : error.message;
    logEntry.delivered_at = new Date().toISOString();
  }

  saveWebhookLogs(logs);
  return logEntry;
}

// Notify vendors about product changes
async function notifyVendors(eventType, product, previousStock = null) {
  const vendors = loadVendors();
  
  const payload = {
    event_type: eventType,
    timestamp: new Date().toISOString(),
    data: {
      product_id: product.id,
      sku: product.sku,
      name: product.name,
      supplier_id: product.supplier_id,
      supplier_name: product.supplier_name,
      category: product.category,
      description: product.description,
      price: product.price,
      currency: product.currency,
      stock_quantity: product.stock_quantity,
      previous_stock: previousStock,
      is_available: product.is_available,
      last_updated: product.last_updated
    }
  };

  for (const vendor of vendors) {
    if (!vendor.is_active || !vendor.webhook_url) continue;
    
    // Check subscription filters
    const sub = vendor.subscription || {};
    let shouldNotify = sub.all_products === true;
    
    if (!shouldNotify && sub.suppliers?.length > 0) {
      shouldNotify = sub.suppliers.some(s => 
        product.supplier_id === s || 
        product.supplier_name.toLowerCase().includes(s.toLowerCase())
      );
    }
    
    if (!shouldNotify && sub.categories?.length > 0) {
      shouldNotify = sub.categories.some(c => 
        product.category.toLowerCase().includes(c.toLowerCase())
      );
    }

    if (shouldNotify) {
      // Fire and forget - don't block response
      deliverWebhook(vendor, payload).catch(console.error);
    }
  }
}

// Load wholesalers data
const wholesalers = require('./data/wholesalers.json');

// ============================================
// ADMIN: SUPPLIER MANAGEMENT
// ============================================

app.post('/v1/admin/suppliers', adminLimiter, requireAdmin, (req, res) => {
  const { name, email, contact_person } = req.body;
  if (!name) return res.status(400).json({ error: 'Supplier name required' });
  
  const suppliers = loadSuppliers();
  if (suppliers.some(s => s.name.toLowerCase() === name.toLowerCase())) {
    return res.status(409).json({ error: 'Supplier already exists' });
  }
  
  const supplier = {
    id: generateId(),
    name, email: email || '', contact_person: contact_person || '',
    api_key: generateSupplierKey(name),
    is_active: true,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  };
  
  suppliers.push(supplier);
  saveSuppliers(suppliers);
  
  res.status(201).json({
    message: 'Supplier created',
    supplier: { id: supplier.id, name: supplier.name, api_key: supplier.api_key, email: supplier.email, is_active: supplier.is_active }
  });
});

app.get('/v1/admin/suppliers', requireAdmin, (req, res) => {
  const suppliers = loadSuppliers();
  res.json({ data: suppliers.map(s => ({ id: s.id, name: s.name, email: s.email, api_key: s.api_key, is_active: s.is_active, created_at: s.created_at })), total: suppliers.length });
});

app.get('/v1/admin/suppliers/:id', requireAdmin, (req, res) => {
  const supplier = loadSuppliers().find(s => s.id === req.params.id);
  if (!supplier) return res.status(404).json({ error: 'Supplier not found' });
  res.json({ data: supplier });
});

app.post('/v1/admin/suppliers/:id/regenerate-key', requireAdmin, (req, res) => {
  const suppliers = loadSuppliers();
  const index = suppliers.findIndex(s => s.id === req.params.id);
  if (index === -1) return res.status(404).json({ error: 'Supplier not found' });
  
  suppliers[index].api_key = generateSupplierKey(suppliers[index].name);
  suppliers[index].updated_at = new Date().toISOString();
  saveSuppliers(suppliers);
  
  res.json({ message: 'API key regenerated', api_key: suppliers[index].api_key });
});

app.put('/v1/admin/suppliers/:id/status', requireAdmin, (req, res) => {
  const { is_active } = req.body;
  if (is_active === undefined) return res.status(400).json({ error: 'is_active required' });
  
  const suppliers = loadSuppliers();
  const index = suppliers.findIndex(s => s.id === req.params.id);
  if (index === -1) return res.status(404).json({ error: 'Supplier not found' });
  
  suppliers[index].is_active = is_active;
  suppliers[index].updated_at = new Date().toISOString();
  saveSuppliers(suppliers);
  
  res.json({ message: 'Status updated', is_active });
});

// ============================================
// ADMIN: VENDOR MANAGEMENT (for webhooks)
// ============================================

app.post('/v1/admin/vendors', requireAdmin, (req, res) => {
  const { name, webhook_url, subscription = {} } = req.body;
  
  if (!name) return res.status(400).json({ error: 'Vendor name required' });
  if (!webhook_url) return res.status(400).json({ error: 'Webhook URL required' });
  
  try { new URL(webhook_url); } catch { return res.status(400).json({ error: 'Invalid webhook URL' }); }
  
  const vendors = loadVendors();
  if (vendors.some(v => v.name.toLowerCase() === name.toLowerCase())) {
    return res.status(409).json({ error: 'Vendor already exists' });
  }
  
  const vendor = {
    id: generateId(),
    name,
    api_key: generateVendorKey(),
    webhook_url,
    subscription: {
      all_products: subscription.all_products || false,
      suppliers: subscription.suppliers || [],
      categories: subscription.categories || []
    },
    is_active: true,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  };
  
  vendors.push(vendor);
  saveVendors(vendors);
  
  res.status(201).json({
    message: 'Vendor registered',
    vendor: { id: vendor.id, name: vendor.name, api_key: vendor.api_key, webhook_url: vendor.webhook_url, subscription: vendor.subscription, is_active: vendor.is_active }
  });
});

app.get('/v1/admin/vendors', requireAdmin, (req, res) => {
  const vendors = loadVendors();
  res.json({ data: vendors.map(v => ({ id: v.id, name: v.name, webhook_url: v.webhook_url, subscription: v.subscription, is_active: v.is_active, created_at: v.created_at })), total: vendors.length });
});

app.get('/v1/admin/vendors/:id', requireAdmin, (req, res) => {
  const vendor = loadVendors().find(v => v.id === req.params.id);
  if (!vendor) return res.status(404).json({ error: 'Vendor not found' });
  res.json({ data: vendor });
});

app.put('/v1/admin/vendors/:id/status', requireAdmin, (req, res) => {
  const { is_active } = req.body;
  if (is_active === undefined) return res.status(400).json({ error: 'is_active required' });
  
  const vendors = loadVendors();
  const index = vendors.findIndex(v => v.id === req.params.id);
  if (index === -1) return res.status(404).json({ error: 'Vendor not found' });
  
  vendors[index].is_active = is_active;
  vendors[index].updated_at = new Date().toISOString();
  saveVendors(vendors);
  
  res.json({ message: 'Status updated', is_active });
});

app.get('/v1/admin/webhook-logs', requireAdmin, (req, res) => {
  const { vendor_id, status, limit = 100 } = req.query;
  let logs = loadWebhookLogs();
  
  if (vendor_id) logs = logs.filter(l => l.vendor_id === vendor_id);
  if (status) logs = logs.filter(l => l.status === status);
  
  logs = logs.slice(-parseInt(limit)).reverse();
  res.json({ data: logs, total: logs.length });
});

// ============================================
// VENDOR: SELF MANAGEMENT
// ============================================

const requireVendor = (req, res, next) => {
  const key = getApiKey(req);
  const vendors = loadVendors();
  const vendor = vendors.find(v => v.api_key === key);
  
  if (!vendor) return res.status(403).json({ error: 'Invalid vendor key' });
  
  req.vendor = vendor;
  next();
};

app.get('/v1/vendor/me', requireVendor, (req, res) => {
  res.json({
    data: {
      id: req.vendor.id,
      name: req.vendor.name,
      webhook_url: req.vendor.webhook_url,
      subscription: req.vendor.subscription,
      is_active: req.vendor.is_active
    }
  });
});

app.put('/v1/vendor/me/webhook', requireVendor, (req, res) => {
  const { webhook_url } = req.body;
  if (!webhook_url) return res.status(400).json({ error: 'Webhook URL required' });
  
  try { new URL(webhook_url); } catch { return res.status(400).json({ error: 'Invalid URL' }); }
  
  const vendors = loadVendors();
  const index = vendors.findIndex(v => v.id === req.vendor.id);
  vendors[index].webhook_url = webhook_url;
  vendors[index].updated_at = new Date().toISOString();
  saveVendors(vendors);
  
  res.json({ message: 'Webhook URL updated', webhook_url });
});

app.put('/v1/vendor/me/subscription', requireVendor, (req, res) => {
  const { all_products, suppliers, categories } = req.body;
  const vendors = loadVendors();
  const index = vendors.findIndex(v => v.id === req.vendor.id);
  
  if (all_products !== undefined) vendors[index].subscription.all_products = all_products;
  if (suppliers !== undefined) vendors[index].subscription.suppliers = suppliers;
  if (categories !== undefined) vendors[index].subscription.categories = categories;
  
  vendors[index].updated_at = new Date().toISOString();
  saveVendors(vendors);
  
  res.json({ message: 'Subscription updated', subscription: vendors[index].subscription });
});

app.post('/v1/vendor/me/test-webhook', requireVendor, async (req, res) => {
  const testPayload = {
    event_type: 'webhook.test',
    timestamp: new Date().toISOString(),
    data: { message: 'Test webhook from Belgian Roofing API', vendor_id: req.vendor.id, vendor_name: req.vendor.name }
  };
  
  const result = await deliverWebhook(req.vendor, testPayload);
  res.json({ message: 'Test webhook sent', status: result.status, delivered_at: result.delivered_at, error: result.error });
});

// ============================================
// SUPPLIER: PRODUCT UPLOAD (with webhooks)
// ============================================

app.post('/v1/supplier/upload-products', adminLimiter, requireSupplier, express.text({ type: 'text/csv', limit: '10mb' }), async (req, res) => {
  if (!req.body) return res.status(400).json({ error: 'CSV data required' });
  
  const supplierName = req.supplier ? req.supplier.name : 'Admin';
  const supplierId = req.supplier ? req.supplier.id : 'admin';
  
  const lines = req.body.trim().split('\n');
  if (lines.length < 2) return res.status(400).json({ error: 'CSV must have header and data rows' });
  
  const header = lines[0].split(',').map(h => h.trim().toLowerCase().replace(/^"|"$/g, ''));
  const required = ['sku', 'name', 'category', 'stock_quantity', 'price'];
  const missing = required.filter(col => !header.includes(col));
  if (missing.length > 0) return res.status(400).json({ error: 'Missing columns', missing, required });
  
  const colIdx = {};
  required.forEach(col => colIdx[col] = header.indexOf(col));
  ['description', 'currency'].forEach(col => {
    if (header.includes(col)) colIdx[col] = header.indexOf(col);
  });
  
  const products = loadProducts();
  const results = { success: 0, created: 0, updated: 0, errors: [], notifications: [] };
  
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    
    const values = [];
    let current = '', inQuotes = false;
    for (let j = 0; j < line.length; j++) {
      const char = line[j];
      if (char === '"') inQuotes = !inQuotes;
      else if (char === ',' && !inQuotes) { values.push(current.trim()); current = ''; }
      else current += char;
    }
    values.push(current.trim());
    
    const sku = values[colIdx.sku]?.replace(/^"|"$/g, '');
    const name = values[colIdx.name]?.replace(/^"|"$/g, '');
    const category = values[colIdx.category]?.replace(/^"|"$/g, '');
    const stockQty = parseInt(values[colIdx.stock_quantity]);
    const price = parseFloat(values[colIdx.price]);
    const description = colIdx.description !== undefined ? values[colIdx.description]?.replace(/^"|"$/g, '') : '';
    const currency = colIdx.currency !== undefined ? values[colIdx.currency]?.replace(/^"|"$/g, '') : 'EUR';
    
    const errors = [];
    if (!sku) errors.push('SKU required');
    if (!name) errors.push('Name required');
    if (!category) errors.push('Category required');
    if (isNaN(stockQty)) errors.push('Stock must be number');
    if (isNaN(price) || price < 0) errors.push('Price must be positive');
    if (errors.length > 0) {
      results.errors.push({ row: i + 1, sku, errors });
      continue;
    }
    
    const existingIdx = products.findIndex(p => p.sku.toLowerCase() === sku.toLowerCase());
    let previousStock = null;
    let eventType = 'product.created';
    
    if (existingIdx >= 0) {
      if (!req.isAdmin && products[existingIdx].supplier_id !== supplierId) {
        results.errors.push({ row: i + 1, sku, errors: ['Product belongs to another supplier'] });
        continue;
      }
      previousStock = products[existingIdx].stock_quantity;
      eventType = previousStock !== stockQty ? 'stock.updated' : 'product.updated';
      
      products[existingIdx] = {
        ...products[existingIdx],
        name, category, description, stock_quantity: stockQty, price, currency,
        last_updated: new Date().toISOString(),
        is_available: stockQty > 0
      };
      results.updated++;
    } else {
      products.push({
        id: generateId(),
        supplier_id: supplierId,
        supplier_name: supplierName,
        sku, name, category, description, stock_quantity: stockQty, price, currency,
        last_updated: new Date().toISOString(),
        is_available: stockQty > 0
      });
      results.created++;
    }
    results.success++;
    
    // Notify vendors about change
    const product = existingIdx >= 0 ? products[existingIdx] : products[products.length - 1];
    notifyVendors(eventType, product, previousStock);
    results.notifications.push({ sku, event: eventType });
  }
  
  saveProducts(products);
  
  res.json({
    message: 'Upload processed',
    summary: {
      total_rows: lines.length - 1,
      successful: results.success,
      created: results.created,
      updated: results.updated,
      errors: results.errors.length,
      notifications_sent: results.notifications.length
    },
    errors: results.errors.length > 0 ? results.errors : undefined
  });
});

app.get('/v1/supplier/my-products', requireSupplier, (req, res) => {
  const products = loadProducts();
  const myProducts = req.isAdmin ? products : products.filter(p => p.supplier_id === req.supplier.id);
  res.json({ data: myProducts, total: myProducts.length });
});

// ============================================
// PUBLIC/VENDOR: PRODUCT READ
// ============================================

app.get('/v1/products', (req, res) => {
  const { page = 1, limit = 50, supplier, category, search, min_stock, max_stock, available_only } = req.query;
  let products = loadProducts();
  
  if (supplier) {
    const s = supplier.toLowerCase();
    products = products.filter(p => p.supplier_name.toLowerCase().includes(s));
  }
  if (category) {
    const c = category.toLowerCase();
    products = products.filter(p => p.category.toLowerCase().includes(c));
  }
  if (search) {
    const q = search.toLowerCase();
    products = products.filter(p => p.name.toLowerCase().includes(q) || p.sku.toLowerCase().includes(q));
  }
  if (min_stock !== undefined) products = products.filter(p => p.stock_quantity >= parseInt(min_stock));
  if (max_stock !== undefined) products = products.filter(p => p.stock_quantity <= parseInt(max_stock));
  if (available_only === 'true') products = products.filter(p => p.is_available && p.stock_quantity > 0);
  
  const start = (page - 1) * limit;
  const paginated = products.slice(start, start + parseInt(limit));
  
  res.json({
    data: paginated,
    meta: { total: products.length, page: parseInt(page), per_page: parseInt(limit), total_pages: Math.ceil(products.length / limit) }
  });
});

app.get('/v1/products/:sku', (req, res) => {
  const products = loadProducts();
  const product = products.find(p => p.sku.toLowerCase() === req.params.sku.toLowerCase());
  if (!product) return res.status(404).json({ error: 'Product not found' });
  res.json({ data: product });
});

app.get('/v1/products/low-stock', (req, res) => {
  const { threshold = 10, page = 1, limit = 50 } = req.query;
  const products = loadProducts().filter(p => p.stock_quantity < parseInt(threshold) && p.is_available);
  const start = (page - 1) * limit;
  res.json({
    data: products.slice(start, start + parseInt(limit)),
    meta: { total: products.length, page: parseInt(page), per_page: parseInt(limit), threshold: parseInt(threshold) }
  });
});

app.get('/v1/categories', (req, res) => {
  const categories = [...new Set(loadProducts().map(p => p.category))].sort();
  res.json({ data: categories, total: categories.length });
});

// ============================================
// WHOLESALERS
// ============================================

app.get('/v1/wholesalers', (req, res) => {
  const { page = 1, limit = 50, region, city } = req.query;
  let results = [...wholesalers];
  if (region) results = results.filter(w => w.regions?.some(r => r.toLowerCase().includes(region.toLowerCase())));
  if (city) results = results.filter(w => w.city?.toLowerCase().includes(city.toLowerCase()));
  const start = (page - 1) * limit;
  res.json({ data: results.slice(start, start + parseInt(limit)), meta: { total: results.length, page: parseInt(page), per_page: parseInt(limit) } });
});

app.get('/v1/wholesalers/search', (req, res) => {
  const { q } = req.query;
  if (!q) return res.status(400).json({ error: 'Query required' });
  const results = wholesalers.filter(w => w.name?.toLowerCase().includes(q.toLowerCase()));
  res.json({ data: results, total: results.length });
});

app.get('/v1/wholesalers/:id', (req, res) => {
  const company = wholesalers.find(w => w.name.toLowerCase().replace(/\s+/g, '-') === req.params.id.toLowerCase());
  if (!company) return res.status(404).json({ error: 'Not found' });
  res.json({ data: company });
});

app.get('/v1/regions', (req, res) => {
  const regions = [...new Set(wholesalers.flatMap(w => w.regions || []))];
  res.json({ data: regions });
});

app.get('/v1/stats', (req, res) => {
  const products = loadProducts();
  const suppliers = loadSuppliers();
  const vendors = loadVendors();
  const totalTurnover = wholesalers.reduce((sum, w) => sum + (w.turnover_eur || 0), 0);
  res.json({
    total_companies: wholesalers.length,
    total_products: products.length,
    active_suppliers: suppliers.filter(s => s.is_active).length,
    active_vendors: vendors.filter(v => v.is_active).length,
    total_turnover_eur: totalTurnover
  });
});

// ============================================
// HEALTH & ROOT
// ============================================

app.get('/health', (req, res) => res.json({ status: 'ok', timestamp: new Date().toISOString(), version: '2.1.0' }));

app.get('/', (req, res) => {
  res.json({
    name: 'Belgian Roofing Wholesalers API',
    version: '2.1.0',
    features: ['Supplier-specific keys', 'Product upload', 'Vendor API', 'Webhooks'],
    endpoints: {
      admin: ['/v1/admin/suppliers', '/v1/admin/vendors', '/v1/admin/webhook-logs'],
      supplier: ['/v1/supplier/upload-products', '/v1/supplier/my-products'],
      vendor: ['/v1/vendor/me', '/v1/vendor/me/webhook', '/v1/vendor/me/subscription', '/v1/vendor/me/test-webhook'],
      public: ['/v1/products', '/v1/wholesalers', '/v1/stats'],
      upload_portal: '/upload.html'
    }
  });
});

app.listen(PORT, () => {
  console.log(`API v2.1 running on port ${PORT}`);
  console.log(`Upload portal: http://localhost:${PORT}/upload.html`);
});
