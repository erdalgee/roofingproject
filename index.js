const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

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

// Load data
const wholesalers = require('./data/wholesalers.json');

// Routes
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
  
  res.json({
    total_companies: wholesalers.length,
    with_turnover_data: withTurnover,
    total_turnover_eur: totalTurnover,
    avg_turnover_eur: withTurnover ? Math.round(totalTurnover / withTurnover) : 0
  });
});

app.get('/health', (req, res) => res.json({ status: 'ok', timestamp: new Date().toISOString() }));

app.get('/', (req, res) => {
  res.json({
    name: 'Belgian Roofing Wholesalers API',
    version: '1.0.0',
    endpoints: {
      'GET /v1/wholesalers': 'List all wholesalers',
      'GET /v1/wholesalers/search?q=': 'Search wholesalers',
      'GET /v1/wholesalers/:id': 'Get single wholesaler',
      'GET /v1/regions': 'List regions',
      'GET /v1/stats': 'API statistics',
      'GET /health': 'Health check'
    },
    auth: 'Use ?api_key=demo-key or header X-API-Key: demo-key'
  });
});

app.listen(PORT, () => {
  console.log(`API running on port ${PORT}`);
});
