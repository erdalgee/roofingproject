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

// Rate limiting
const limiter = rateLimit({
  windowMs: 24 * 60 * 60 * 1000,
  max: 100,
  message: { error: 'Rate limit exceeded' }
});
app.use(limiter);

// Admin rate limiter (more generous for uploads)
const adminLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 50,
  message: { error: 'Admin rate limit exceeded' }
});

// API Key auth
const validKeys = new Set(['demo-key', process.env.ADMIN_KEY || 'admin-key']);

app.use((req, res, next) => {
  const key = req.headers['x-api-key'] || req.query.api_key;
  if (!key || !validKeys.has(key)) {
    return res.status(401).json({ error: 'Invalid or missing API key. Use ?api_key=demo-key' });
  }
  req.apiKey = key;
  next();
});

// Admin auth middleware
const requireAdmin = (req, res, next) => {
  const adminKey = process.env.ADMIN_KEY || 'admin-key';
  if (req.apiKey !== adminKey) {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
};

// Data paths
const DATA_DIR = path.join(__dirname, 'data');
const PRODUCTS_FILE = path.join(DATA_DIR, 'products.json');
const VENDORS_FILE = path.join(DATA_DIR, 'vendors.json');
const WEBHOOK_LOG_FILE = path.join(DATA_DIR, 'webhook_logs.json');

// Ensure data files exist
function ensureDataFiles() {
  if (!fs.existsSync(PRODUCTS_FILE)) {
    fs.writeFileSync(PRODUCTS_FILE, JSON.stringify([], null, 2));
  }
  if (!fs.existsSync(VENDORS_FILE)) {
    fs.writeFileSync(VENDORS_FILE, JSON.stringify([], null, 2));
  }
  if (!fs.existsSync(WEBHOOK_LOG_FILE)) {
    fs.writeFileSync(WEBHOOK_LOG_FILE, JSON.stringify([], null, 2));
  }
}
ensureDataFiles();

// Data access functions
function loadProducts() {
  try {
    return JSON.parse(fs.readFileSync(PRODUCTS_FILE, 'utf8'));
  } catch (e) {
    return [];
  }
}

function saveProducts(products) {
  fs.writeFileSync(PRODUCTS_FILE, JSON.stringify(products, null, 2));
}

function loadVendors() {
  try {
    return JSON.parse(fs.readFileSync(VENDORS_FILE, 'utf8'));
  } catch (e) {
    return [];
  }
}

function saveVendors(vendors) {
  fs.writeFileSync(VENDORS_FILE, JSON.stringify(vendors, null, 2));
}

function loadWebhookLogs() {
  try {
    return JSON.parse(fs.readFileSync(WEBHOOK_LOG_FILE, 'utf8'));
  } catch (e) {
    return [];
  }
}

function saveWebhookLogs(logs) {
  fs.writeFileSync(WEBHOOK_LOG_FILE, JSON.stringify(logs, null, 2));
}

// Generate unique ID
function generateId() {
  return crypto.randomUUID();
}

// Generate API key
function generateApiKey() {
  return 'vnd_' + crypto.randomBytes(32).toString('hex');
}

// Webhook delivery function
async function deliverWebhook(vendor, payload) {
  const logEntry = {
    id: generateId(),
    vendor_id: vendor.id,
    webhook_url: vendor.webhook_url,
    payload: payload,
    status: 'pending',
    created_at: new Date().toISOString(),
    delivered_at: null,
    error: null
  };

  const logs = loadWebhookLogs();
  logs.push(logEntry);
  saveWebhookLogs(logs);

  try {
    const response = await fetch(vendor.webhook_url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Webhook-Secret': vendor.api_key,
        'X-Event-Type': payload.event_type,
        'User-Agent': 'BelgianRoofingAPI/1.0'
      },
      body: JSON.stringify(payload),
      timeout: 30000
    });

    logEntry.status = response.ok ? 'delivered' : 'failed';
    logEntry.http_status = response.status;
    logEntry.delivered_at = new Date().toISOString();
    
    if (!response.ok) {
      logEntry.error = `HTTP ${response.status}: ${await response.text()}`;
    }
  } catch (error) {
    logEntry.status = 'failed';
    logEntry.error = error.message;
    logEntry.delivered_at = new Date().toISOString();
  }

  saveWebhookLogs(logs);
  return logEntry;
}

// Notify vendors about stock change
async function notifyStockChange(product, previousStock) {
  const vendors = loadVendors();
  const payload = {
    event_type: 'stock.updated',
    timestamp: new Date().toISOString(),
    data: {
      product_id: product.id,
      sku: product.sku,
      name: product.name,
      supplier_id: product.supplier_id,
      supplier_name: product.supplier_name,
      category: product.category,
      previous_stock: previousStock,
      current_stock: product.stock_quantity,
      price: product.price,
      currency: product.currency,
      is_available: product.is_available,
      last_updated: product.last_updated
    }
  };

  for (const vendor of vendors) {
    if (!vendor.is_active) continue;
    
    // Check if vendor subscribes to this product
    const sub = vendor.subscription || {};
    let shouldNotify = sub.all_products === true;
    
    if (!shouldNotify && sub.suppliers && sub.suppliers.length > 0) {
      shouldNotify = sub.suppliers.includes(product.supplier_id) ||
                     sub.suppliers.includes(product.supplier_name.toLowerCase());
    }
    
    if (!shouldNotify && sub.categories && sub.categories.length > 0) {
      shouldNotify = sub.categories.some(cat => 
        product.category.toLowerCase().includes(cat.toLowerCase())
      );
    }

    if (shouldNotify) {
      // Fire and forget - don't block response
      deliverWebhook(vendor, payload).catch(console.error);
    }
  }
}

// Load data
const wholesalers = require('./data/wholesalers.json');

// ============================================
// EXISTING WHOLESALER ENDPOINTS
// ============================================

app.get('/v1/wholesalers', (req, res) => {
  const { page = 1, limit = 50, region, city, min_turnover, max_turnover } = req.query;
  let results = [...wholesalers];
  
  if (region) {
    results = results.filter(w => w.regions?.some(r => r.toLowerCase().includes(region.toLowerCase())));
  }
  if (city) {
    results = results.filter(w => w.city?.toLowerCase().includes(city.toLowerCase()));
  }
  if (min_turnover) {
    results = results.filter(w => w.turnover_eur >= parseInt(min_turnover));
  }
  if (max_turnover) {
    results = results.filter(w => w.turnover_eur <= parseInt(max_turnover));
  }
  
  const start = (page - 1) * limit;
  const paginated = results.slice(start, start + parseInt(limit));
  
  res.json({
    data: paginated,
    meta: {
      total: results.length,
      page: parseInt(page),
      per_page: parseInt(limit),
      total_pages: Math.ceil(results.length / limit)
    }
  });
});

app.get('/v1/wholesalers/search', (req, res) => {
  const { q } = req.query;
  if (!q) return res.status(400).json({ error: 'Query parameter "q" required' });
  
  const results = wholesalers.filter(w => 
    w.name?.toLowerCase().includes(q.toLowerCase()) ||
    w.city?.toLowerCase().includes(q.toLowerCase()) ||
    w.regions?.some(r => r.toLowerCase().includes(q.toLowerCase()))
  );
  
  res.json({ data: results, total: results.length });
});

app.get('/v1/wholesalers/:id', (req, res) => {
  const company = wholesalers.find(w => 
    w.name.toLowerCase().replace(/\s+/g, '-') === req.params.id.toLowerCase() ||
    w.name.toLowerCase() === req.params.id.toLowerCase()
  );
  if (!company) return res.status(404).json({ error: 'Company not found' });
  res.json({ data: company });
});

app.get('/v1/regions', (req, res) => {
  const regions = [...new Set(wholesalers.flatMap(w => w.regions || []))];
  res.json({ data: regions });
});

app.get('/v1/stats', (req, res) => {
  const totalTurnover = wholesalers.reduce((sum, w) => sum + (w.turnover_eur || 0), 0);
  const withTurnover = wholesalers.filter(w => w.turnover_eur).length;
  const products = loadProducts();
  const vendors = loadVendors();
  
  res.json({
    total_companies: wholesalers.length,
    with_turnover_data: withTurnover,
    total_turnover_eur: totalTurnover,
    avg_turnover_eur: withTurnover ? Math.round(totalTurnover / withTurnover) : 0,
    total_products: products.length,
    active_vendors: vendors.filter(v => v.is_active).length
  });
});

// ============================================
// PRODUCT API ENDPOINTS (SaaS Vendor API)
// ============================================

// List all products with filtering
app.get('/v1/products', (req, res) => {
  const { 
    page = 1, 
    limit = 50, 
    supplier, 
    category, 
    search,
    min_stock,
    max_stock,
    min_price,
    max_price,
    available_only = 'false'
  } = req.query;
  
  let products = loadProducts();
  
  // Filter by supplier
  if (supplier) {
    const supplierLower = supplier.toLowerCase();
    products = products.filter(p => 
      p.supplier_name.toLowerCase().includes(supplierLower) ||
      p.supplier_id.toLowerCase() === supplierLower
    );
  }
  
  // Filter by category
  if (category) {
    const categoryLower = category.toLowerCase();
    products = products.filter(p => 
      p.category.toLowerCase().includes(categoryLower)
    );
  }
  
  // Search in name and description
  if (search) {
    const searchLower = search.toLowerCase();
    products = products.filter(p => 
      p.name.toLowerCase().includes(searchLower) ||
      (p.description && p.description.toLowerCase().includes(searchLower)) ||
      p.sku.toLowerCase().includes(searchLower)
    );
  }
  
  // Filter by stock range
  if (min_stock !== undefined) {
    products = products.filter(p => p.stock_quantity >= parseInt(min_stock));
  }
  if (max_stock !== undefined) {
    products = products.filter(p => p.stock_quantity <= parseInt(max_stock));
  }
  
  // Filter by price range
  if (min_price !== undefined) {
    products = products.filter(p => p.price >= parseFloat(min_price));
  }
  if (max_price !== undefined) {
    products = products.filter(p => p.price <= parseFloat(max_price));
  }
  
  // Filter available only
  if (available_only === 'true') {
    products = products.filter(p => p.is_available && p.stock_quantity > 0);
  }
  
  // Pagination
  const start = (page - 1) * limit;
  const paginated = products.slice(start, start + parseInt(limit));
  
  res.json({
    data: paginated,
    meta: {
      total: products.length,
      page: parseInt(page),
      per_page: parseInt(limit),
      total_pages: Math.ceil(products.length / limit)
    }
  });
});

// Get single product by SKU
app.get('/v1/products/:sku', (req, res) => {
  const products = loadProducts();
  const product = products.find(p => p.sku.toLowerCase() === req.params.sku.toLowerCase());
  
  if (!product) {
    return res.status(404).json({ error: 'Product not found' });
  }
  
  res.json({ data: product });
});

// Get low stock products
app.get('/v1/products/low-stock', (req, res) => {
  const { threshold = 10, page = 1, limit = 50 } = req.query;
  const products = loadProducts();
  
  const lowStock = products.filter(p => 
    p.stock_quantity < parseInt(threshold) && p.is_available
  );
  
  const start = (page - 1) * limit;
  const paginated = lowStock.slice(start, start + parseInt(limit));
  
  res.json({
    data: paginated,
    meta: {
      total: lowStock.length,
      page: parseInt(page),
      per_page: parseInt(limit),
      total_pages: Math.ceil(lowStock.length / limit),
      threshold: parseInt(threshold)
    }
  });
});

// Get product categories
app.get('/v1/categories', (req, res) => {
  const products = loadProducts();
  const categories = [...new Set(products.map(p => p.category))].sort();
  
  res.json({
    data: categories,
    total: categories.length
  });
});

// ============================================
// ADMIN CSV UPLOAD ENDPOINT
// ============================================

// CSV Upload endpoint
app.post('/v1/admin/upload-products', adminLimiter, requireAdmin, express.text({ type: 'text/csv', limit: '10mb' }), (req, res) => {
  if (!req.body) {
    return res.status(400).json({ error: 'CSV data required in request body' });
  }

  const csvData = req.body;
  const lines = csvData.trim().split('\n');
  
  if (lines.length < 2) {
    return res.status(400).json({ error: 'CSV must have at least a header row and one data row' });
  }
  
  // Parse header
  const header = lines[0].split(',').map(h => h.trim().toLowerCase().replace(/^"|"$/g, ''));
  const requiredColumns = ['sku', 'name', 'category', 'stock_quantity', 'price', 'supplier_name'];
  
  const missingColumns = requiredColumns.filter(col => !header.includes(col));
  if (missingColumns.length > 0) {
    return res.status(400).json({ 
      error: 'Missing required columns', 
      missing: missingColumns,
      required: requiredColumns,
      found: header
    });
  }
  
  const colIndex = {};
  requiredColumns.forEach(col => {
    colIndex[col] = header.indexOf(col);
  });
  
  // Optional columns
  const optionalColumns = ['description', 'currency'];
  optionalColumns.forEach(col => {
    if (header.includes(col)) {
      colIndex[col] = header.indexOf(col);
    }
  });
  
  const products = loadProducts();
  const results = {
    success: 0,
    errors: [],
    updated: 0,
    created: 0
  };
  
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    
    // Parse CSV line (handle quoted values)
    const values = [];
    let current = '';
    let inQuotes = false;
    
    for (let j = 0; j < line.length; j++) {
      const char = line[j];
      if (char === '"') {
        inQuotes = !inQuotes;
      } else if (char === ',' && !inQuotes) {
        values.push(current.trim());
        current = '';
      } else {
        current += char;
      }
    }
    values.push(current.trim());
    
    // Extract values
    const sku = values[colIndex.sku]?.replace(/^"|"$/g, '');
    const name = values[colIndex.name]?.replace(/^"|"$/g, '');
    const category = values[colIndex.category]?.replace(/^"|"$/g, '');
    const stockQuantity = parseInt(values[colIndex.stock_quantity]);
    const price = parseFloat(values[colIndex.price]);
    const supplierName = values[colIndex.supplier_name]?.replace(/^"|"$/g, '');
    const description = colIndex.description !== undefined ? values[colIndex.description]?.replace(/^"|"$/g, '') : '';
    const currency = colIndex.currency !== undefined ? values[colIndex.currency]?.replace(/^"|"$/g, '') : 'EUR';
    
    // Validation
    const errors = [];
    if (!sku) errors.push('SKU is required');
    if (!name) errors.push('Name is required');
    if (!category) errors.push('Category is required');
    if (isNaN(stockQuantity)) errors.push('Stock quantity must be a number');
    if (isNaN(price) || price < 0) errors.push('Price must be a positive number');
    if (!supplierName) errors.push('Supplier name is required');
    
    if (errors.length > 0) {
      results.errors.push({ row: i + 1, sku, errors });
      continue;
    }
    
    // Find supplier
    const supplier = wholesalers.find(w => 
      w.name.toLowerCase().includes(supplierName.toLowerCase()) ||
      w.name.toLowerCase().replace(/\s+/g, '-').includes(supplierName.toLowerCase().replace(/\s+/g, '-'))
    );
    
    const supplierId = supplier ? 
      supplier.name.toLowerCase().replace(/\s+/g, '-') : 
      supplierName.toLowerCase().replace(/\s+/g, '-');
    
    // Check if product exists
    const existingIndex = products.findIndex(p => p.sku.toLowerCase() === sku.toLowerCase());
    const previousStock = existingIndex >= 0 ? products[existingIndex].stock_quantity : null;
    
    const product = {
      id: existingIndex >= 0 ? products[existingIndex].id : generateId(),
      supplier_id: supplierId,
      sku: sku,
      name: name,
      category: category,
      description: description || '',
      stock_quantity: stockQuantity,
      price: price,
      currency: currency || 'EUR',
      supplier_name: supplier ? supplier.name : supplierName,
      last_updated: new Date().toISOString(),
      is_available: stockQuantity > 0
    };
    
    if (existingIndex >= 0) {
      products[existingIndex] = product;
      results.updated++;
      
      // Notify vendors if stock changed
      if (previousStock !== null && previousStock !== stockQuantity) {
        notifyStockChange(product, previousStock).catch(console.error);
      }
    } else {
      products.push(product);
      results.created++;
    }
    
    results.success++;
  }
  
  saveProducts(products);
  
  res.json({
    message: 'CSV upload processed successfully',
    summary: {
      total_rows: lines.length - 1,
      successful: results.success,
      created: results.created,
      updated: results.updated,
      errors: results.errors.length
    },
    errors: results.errors.length > 0 ? results.errors : undefined
  });
});

// Get all products (admin)
app.get('/v1/admin/products', requireAdmin, (req, res) => {
  const products = loadProducts();
  res.json({ data: products, total: products.length });
});

// Update single product (admin)
app.put('/v1/admin/products/:sku', requireAdmin, (req, res) => {
  const { sku } = req.params;
  const updates = req.body;
  const products = loadProducts();
  
  const index = products.findIndex(p => p.sku.toLowerCase() === sku.toLowerCase());
  if (index === -1) {
    return res.status(404).json({ error: 'Product not found' });
  }
  
  const previousStock = products[index].stock_quantity;
  
  // Update allowed fields
  const allowedFields = ['name', 'category', 'description', 'stock_quantity', 'price', 'currency', 'is_available'];
  allowedFields.forEach(field => {
    if (updates[field] !== undefined) {
      products[index][field] = updates[field];
    }
  });
  
  products[index].last_updated = new Date().toISOString();
  
  saveProducts(products);
  
  // Notify if stock changed
  if (updates.stock_quantity !== undefined && previousStock !== updates.stock_quantity) {
    notifyStockChange(products[index], previousStock).catch(console.error);
  }
  
  res.json({ data: products[index] });
});

// Delete product (admin)
app.delete('/v1/admin/products/:sku', requireAdmin, (req, res) => {
  const { sku } = req.params;
  let products = loadProducts();
  
  const initialLength = products.length;
  products = products.filter(p => p.sku.toLowerCase() !== sku.toLowerCase());
  
  if (products.length === initialLength) {
    return res.status(404).json({ error: 'Product not found' });
  }
  
  saveProducts(products);
  res.json({ message: 'Product deleted successfully' });
});

// ============================================
// VENDOR MANAGEMENT ENDPOINTS
// ============================================

// Register new vendor
app.post('/v1/vendors/register', (req, res) => {
  const { name, webhook_url, subscription = {} } = req.body;
  
  if (!name) {
    return res.status(400).json({ error: 'Vendor name is required' });
  }
  if (!webhook_url) {
    return res.status(400).json({ error: 'Webhook URL is required' });
  }
  
  // Validate webhook URL
  try {
    new URL(webhook_url);
  } catch (e) {
    return res.status(400).json({ error: 'Invalid webhook URL' });
  }
  
  const vendors = loadVendors();
  
  // Check if vendor name already exists
  if (vendors.some(v => v.name.toLowerCase() === name.toLowerCase())) {
    return res.status(409).json({ error: 'Vendor with this name already exists' });
  }
  
  const vendor = {
    id: generateId(),
    name: name,
    api_key: generateApiKey(),
    webhook_url: webhook_url,
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
    message: 'Vendor registered successfully',
    vendor: {
      id: vendor.id,
      name: vendor.name,
      api_key: vendor.api_key,
      webhook_url: vendor.webhook_url,
      subscription: vendor.subscription,
      is_active: vendor.is_active,
      created_at: vendor.created_at
    }
  });
});

// Get vendor details (requires vendor's own API key)
app.get('/v1/vendors/me', (req, res) => {
  const vendors = loadVendors();
  const vendor = vendors.find(v => v.api_key === req.apiKey);
  
  if (!vendor) {
    return res.status(404).json({ error: 'Vendor not found' });
  }
  
  res.json({
    data: {
      id: vendor.id,
      name: vendor.name,
      webhook_url: vendor.webhook_url,
      subscription: vendor.subscription,
      is_active: vendor.is_active,
      created_at: vendor.created_at
    }
  });
});

// Update vendor subscription
app.put('/v1/vendors/me/subscription', (req, res) => {
  const vendors = loadVendors();
  const vendorIndex = vendors.findIndex(v => v.api_key === req.apiKey);
  
  if (vendorIndex === -1) {
    return res.status(404).json({ error: 'Vendor not found' });
  }
  
  const { all_products, suppliers, categories } = req.body;
  
  if (all_products !== undefined) {
    vendors[vendorIndex].subscription.all_products = all_products;
  }
  if (suppliers !== undefined) {
    vendors[vendorIndex].subscription.suppliers = suppliers;
  }
  if (categories !== undefined) {
    vendors[vendorIndex].subscription.categories = categories;
  }
  
  vendors[vendorIndex].updated_at = new Date().toISOString();
  saveVendors(vendors);
  
  res.json({
    message: 'Subscription updated',
    subscription: vendors[vendorIndex].subscription
  });
});

// Update vendor webhook URL
app.put('/v1/vendors/me/webhook', (req, res) => {
  const { webhook_url } = req.body;
  
  if (!webhook_url) {
    return res.status(400).json({ error: 'Webhook URL is required' });
  }
  
  try {
    new URL(webhook_url);
  } catch (e) {
    return res.status(400).json({ error: 'Invalid webhook URL' });
  }
  
  const vendors = loadVendors();
  const vendorIndex = vendors.findIndex(v => v.api_key === req.apiKey);
  
  if (vendorIndex === -1) {
    return res.status(404).json({ error: 'Vendor not found' });
  }
  
  vendors[vendorIndex].webhook_url = webhook_url;
  vendors[vendorIndex].updated_at = new Date().toISOString();
  saveVendors(vendors);
  
  res.json({ message: 'Webhook URL updated', webhook_url });
});

// Test webhook (trigger a test event)
app.post('/v1/vendors/me/test-webhook', (req, res) => {
  const vendors = loadVendors();
  const vendor = vendors.find(v => v.api_key === req.apiKey);
  
  if (!vendor) {
    return res.status(404).json({ error: 'Vendor not found' });
  }
  
  const testPayload = {
    event_type: 'webhook.test',
    timestamp: new Date().toISOString(),
    data: {
      message: 'This is a test webhook from Belgian Roofing API',
      vendor_id: vendor.id,
      vendor_name: vendor.name
    }
  };
  
  deliverWebhook(vendor, testPayload)
    .then(result => {
      res.json({
        message: 'Test webhook sent',
        status: result.status,
        delivered_at: result.delivered_at,
        error: result.error
      });
    })
    .catch(error => {
      res.status(500).json({ error: 'Failed to send test webhook', details: error.message });
    });
});

// Admin: List all vendors
app.get('/v1/admin/vendors', requireAdmin, (req, res) => {
  const vendors = loadVendors();
  const sanitizedVendors = vendors.map(v => ({
    id: v.id,
    name: v.name,
    webhook_url: v.webhook_url,
    subscription: v.subscription,
    is_active: v.is_active,
    created_at: v.created_at,
    updated_at: v.updated_at
  }));
  
  res.json({ data: sanitizedVendors, total: sanitizedVendors.length });
});

// Admin: Get vendor by ID
app.get('/v1/admin/vendors/:id', requireAdmin, (req, res) => {
  const vendors = loadVendors();
  const vendor = vendors.find(v => v.id === req.params.id);
  
  if (!vendor) {
    return res.status(404).json({ error: 'Vendor not found' });
  }
  
  res.json({
    data: {
      id: vendor.id,
      name: vendor.name,
      api_key: vendor.api_key,
      webhook_url: vendor.webhook_url,
      subscription: vendor.subscription,
      is_active: vendor.is_active,
      created_at: vendor.created_at,
      updated_at: vendor.updated_at
    }
  });
});

// Admin: Update vendor status
app.put('/v1/admin/vendors/:id/status', requireAdmin, (req, res) => {
  const { is_active } = req.body;
  
  if (is_active === undefined) {
    return res.status(400).json({ error: 'is_active field is required' });
  }
  
  const vendors = loadVendors();
  const vendorIndex = vendors.findIndex(v => v.id === req.params.id);
  
  if (vendorIndex === -1) {
    return res.status(404).json({ error: 'Vendor not found' });
  }
  
  vendors[vendorIndex].is_active = is_active;
  vendors[vendorIndex].updated_at = new Date().toISOString();
  saveVendors(vendors);
  
  res.json({ message: 'Vendor status updated', is_active });
});

// Admin: Delete vendor
app.delete('/v1/admin/vendors/:id', requireAdmin, (req, res) => {
  let vendors = loadVendors();
  const initialLength = vendors.length;
  
  vendors = vendors.filter(v => v.id !== req.params.id);
  
  if (vendors.length === initialLength) {
    return res.status(404).json({ error: 'Vendor not found' });
  }
  
  saveVendors(vendors);
  res.json({ message: 'Vendor deleted successfully' });
});

// Admin: Get webhook logs
app.get('/v1/admin/webhook-logs', requireAdmin, (req, res) => {
  const { vendor_id, status, limit = 100 } = req.query;
  let logs = loadWebhookLogs();
  
  if (vendor_id) {
    logs = logs.filter(l => l.vendor_id === vendor_id);
  }
  if (status) {
    logs = logs.filter(l => l.status === status);
  }
  
  logs = logs.slice(-parseInt(limit)).reverse();
  
  res.json({ data: logs, total: logs.length });
});

// ============================================
// HEALTH & ROOT ENDPOINTS
// ============================================

app.get('/health', (req, res) => res.json({ 
  status: 'ok', 
  timestamp: new Date().toISOString(),
  version: '1.1.0'
}));

app.get('/', (req, res) => {
  res.json({
    name: 'Belgian Roofing Wholesalers API',
    version: '1.1.0',
    endpoints: {
      // Wholesaler endpoints
      'GET /v1/wholesalers': 'List all wholesalers',
      'GET /v1/wholesalers/search?q=': 'Search wholesalers',
      'GET /v1/wholesalers/:id': 'Get single wholesaler',
      'GET /v1/regions': 'List regions',
      'GET /v1/stats': 'API statistics',
      
      // Product endpoints
      'GET /v1/products': 'List all products with filters (supplier, category, search)',
      'GET /v1/products/:sku': 'Get single product by SKU',
      'GET /v1/products/low-stock': 'Get low stock products (threshold param)',
      'GET /v1/categories': 'List product categories',
      
      // Vendor endpoints
      'POST /v1/vendors/register': 'Register as a new vendor',
      'GET /v1/vendors/me': 'Get your vendor details',
      'PUT /v1/vendors/me/subscription': 'Update subscription settings',
      'PUT /v1/vendors/me/webhook': 'Update webhook URL',
      'POST /v1/vendors/me/test-webhook': 'Send test webhook',
      
      // Admin endpoints
      'POST /v1/admin/upload-products': 'Upload products via CSV (admin only)',
      'GET /v1/admin/products': 'List all products (admin)',
      'PUT /v1/admin/products/:sku': 'Update product (admin)',
      'DELETE /v1/admin/products/:sku': 'Delete product (admin)',
      'GET /v1/admin/vendors': 'List all vendors (admin)',
      'GET /v1/admin/vendors/:id': 'Get vendor details (admin)',
      'PUT /v1/admin/vendors/:id/status': 'Update vendor status (admin)',
      'DELETE /v1/admin/vendors/:id': 'Delete vendor (admin)',
      'GET /v1/admin/webhook-logs': 'View webhook delivery logs (admin)',
      
      'GET /health': 'Health check'
    },
    auth: 'Use ?api_key=demo-key or header X-API-Key: demo-key. Admin endpoints require ADMIN_KEY.'
  });
});

app.listen(PORT, () => {
  console.log(`API running on port ${PORT}`);
  console.log(`Data directory: ${DATA_DIR}`);
});
