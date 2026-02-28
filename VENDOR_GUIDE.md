# Belgian Roofing Wholesalers API - Vendor Integration Guide

## Overview

This API allows SaaS vendors (like Teamleader, Robaws) to access real-time stock data from Belgian roofing wholesalers.

## Quick Start

### 1. Register as a Vendor

```bash
curl -X POST https://roofingproject-production.up.railway.app/v1/vendors/register \
  -H "Content-Type: application/json" \
  -H "X-API-Key: demo-key" \
  -d '{
    "name": "Your Company Name",
    "webhook_url": "https://your-domain.com/webhook",
    "subscription": {
      "all_products": false,
      "suppliers": ["defrancq", "apok"],
      "categories": ["dakpannen", "dakbedekking"]
    }
  }'
```

**Response:**
```json
{
  "message": "Vendor registered successfully",
  "vendor": {
    "id": "...",
    "name": "Your Company Name",
    "api_key": "vnd_...",
    "webhook_url": "https://your-domain.com/webhook",
    "subscription": {...}
  }
}
```

**Save your `api_key` - you'll need it for all requests!**

---

### 2. Query Products

Use your vendor API key:

```bash
# List all products
curl "https://roofingproject-production.up.railway.app/v1/products?api_key=vnd_YOUR_KEY"

# Filter by supplier
curl "https://roofingproject-production.up.railway.app/v1/products?supplier=defrancq&api_key=vnd_YOUR_KEY"

# Filter by category
curl "https://roofingproject-production.up.railway.app/v1/products?category=dakpannen&api_key=vnd_YOUR_KEY"

# Search
curl "https://roofingproject-production.up.railway.app/v1/products?search=epdm&api_key=vnd_YOUR_KEY"

# Low stock alert
curl "https://roofingproject-production.up.railway.app/v1/products/low-stock?threshold=20&api_key=vnd_YOUR_KEY"
```

---

### 3. Webhook Integration

Your webhook will receive POST requests when stock changes:

**Headers:**
```
Content-Type: application/json
X-Webhook-Secret: vnd_YOUR_KEY
X-Event-Type: stock.updated
```

**Payload:**
```json
{
  "event_type": "stock.updated",
  "timestamp": "2024-02-28T20:30:00Z",
  "data": {
    "product_id": "...",
    "sku": "DP-001",
    "name": "Dakpan Rood Keramiek",
    "supplier_id": "defrancq",
    "supplier_name": "Defrancq",
    "category": "Dakpannen",
    "previous_stock": 150,
    "current_stock": 95,
    "price": 0.45,
    "currency": "EUR",
    "is_available": true,
    "last_updated": "2024-02-28T20:30:00Z"
  }
}
```

**Your webhook should:**
- Return HTTP 200 on success
- Process the update within 30 seconds
- Verify the `X-Webhook-Secret` header

---

### 4. Test Your Webhook

```bash
curl -X POST "https://roofingproject-production.up.railway.app/v1/vendors/me/test-webhook" \
  -H "X-API-Key: vnd_YOUR_KEY"
```

---

## API Reference

### Product Endpoints

| Endpoint | Description |
|----------|-------------|
| `GET /v1/products` | List all products (paginated) |
| `GET /v1/products?supplier=defrancq` | Filter by supplier |
| `GET /v1/products?category=dakpannen` | Filter by category |
| `GET /v1/products?search=keyword` | Search in name/SKU |
| `GET /v1/products?min_stock=10` | Filter by stock range |
| `GET /v1/products?available_only=true` | Available products only |
| `GET /v1/products/:sku` | Get single product |
| `GET /v1/products/low-stock` | Low stock alerts |
| `GET /v1/categories` | List categories |

### Vendor Endpoints

| Endpoint | Description |
|----------|-------------|
| `POST /v1/vendors/register` | Register new vendor |
| `GET /v1/vendors/me` | Get your details |
| `PUT /v1/vendors/me/subscription` | Update subscription |
| `PUT /v1/vendors/me/webhook` | Update webhook URL |
| `POST /v1/vendors/me/test-webhook` | Test webhook |

---

## Subscription Options

Control which products trigger webhooks:

```json
{
  "all_products": true,
  "suppliers": ["defrancq", "apok", "bmb"],
  "categories": ["dakpannen", "dakbedekking", "isolatie"]
}
```

- `all_products: true` - Receive updates for all products
- `suppliers` - Only products from these suppliers
- `categories` - Only products in these categories

---

## Rate Limits

- Free tier: 100 requests/day
- Vendor API: 1,000 requests/day
- Webhook retries: 3 attempts with exponential backoff

---

## Support

For issues or questions, contact: support@belgianroofing.be
