# Webhook Payload Format

## Overview

The Belgian Roofing API sends webhooks to registered vendors when product stock changes occur. This document describes the payload format for each event type.

## Event Types

### 1. stock.updated

Sent when a product's stock quantity changes.

```json
{
  "event_type": "stock.updated",
  "timestamp": "2025-02-28T12:00:00.000Z",
  "data": {
    "product_id": "550e8400-e29b-41d4-a716-446655440000",
    "sku": "DEF-DP-001",
    "name": "Monier Coppo di Grecia Dakpan Rood",
    "supplier_id": "defrancq",
    "supplier_name": "Defrancq",
    "category": "Dakpannen",
    "previous_stock": 1500,
    "current_stock": 1200,
    "price": 1.85,
    "currency": "EUR",
    "is_available": true,
    "last_updated": "2025-02-28T12:00:00.000Z"
  }
}
```

#### Field Descriptions

| Field | Type | Description |
|-------|------|-------------|
| `event_type` | string | Always `"stock.updated"` |
| `timestamp` | string | ISO 8601 timestamp of when the event was generated |
| `data.product_id` | string | Unique identifier for the product |
| `data.sku` | string | Stock Keeping Unit - unique product code |
| `data.name` | string | Product name |
| `data.supplier_id` | string | Normalized supplier identifier |
| `data.supplier_name` | string | Human-readable supplier name |
| `data.category` | string | Product category |
| `data.previous_stock` | number | Stock quantity before the update |
| `data.current_stock` | number | Current stock quantity |
| `data.price` | number | Unit price in EUR |
| `data.currency` | string | Currency code (e.g., "EUR") |
| `data.is_available` | boolean | Whether the product is currently available |
| `data.last_updated` | string | ISO 8601 timestamp of the product update |

---

### 2. webhook.test

Sent when a vendor requests a test webhook via the API.

```json
{
  "event_type": "webhook.test",
  "timestamp": "2025-02-28T12:00:00.000Z",
  "data": {
    "message": "This is a test webhook from Belgian Roofing API",
    "vendor_id": "vnd_a1b2c3d4-e5f6-7890-abcd-ef1234567890",
    "vendor_name": "Your Company Name"
  }
}
```

#### Field Descriptions

| Field | Type | Description |
|-------|------|-------------|
| `event_type` | string | Always `"webhook.test"` |
| `timestamp` | string | ISO 8601 timestamp |
| `data.message` | string | Human-readable test message |
| `data.vendor_id` | string | Your vendor ID |
| `data.vendor_name` | string | Your registered company name |

---

## HTTP Headers

All webhook requests include the following headers:

| Header | Value | Description |
|--------|-------|-------------|
| `Content-Type` | `application/json` | Content type of the payload |
| `X-Webhook-Secret` | Your API key | Use this to verify the webhook authenticity |
| `X-Event-Type` | Event type | Same as `event_type` in payload |
| `User-Agent` | `BelgianRoofingAPI/1.0` | Identifies the sender |

## Example: Verifying Webhooks (Node.js)

```javascript
const express = require('express');
const crypto = require('crypto');

const app = express();
app.use(express.json());

const WEBHOOK_SECRET = process.env.ROOFING_API_KEY;

app.post('/webhooks/roofing-api', (req, res) => {
  // Verify the webhook secret
  const secret = req.headers['x-webhook-secret'];
  if (secret !== WEBHOOK_SECRET) {
    console.error('Invalid webhook secret');
    return res.status(401).send('Unauthorized');
  }

  const event = req.body;
  
  // Verify event structure
  if (!event.event_type || !event.timestamp || !event.data) {
    console.error('Invalid webhook payload structure');
    return res.status(400).send('Bad Request');
  }
  
  // Process the event
  console.log(`Received ${event.event_type} at ${event.timestamp}`);
  
  switch (event.event_type) {
    case 'stock.updated':
      handleStockUpdate(event.data);
      break;
    case 'webhook.test':
      console.log('Test webhook:', event.data.message);
      break;
    default:
      console.log('Unknown event type:', event.event_type);
  }
  
  // Always respond with 200 OK quickly
  res.status(200).send('OK');
});

function handleStockUpdate(data) {
  console.log(`Stock update for ${data.sku}:`);
  console.log(`  Previous: ${data.previous_stock}`);
  console.log(`  Current: ${data.current_stock}`);
  console.log(`  Available: ${data.is_available}`);
  
  // Update your database, notify customers, etc.
}

app.listen(3000, () => {
  console.log('Webhook receiver listening on port 3000');
});
```

## Example: Verifying Webhooks (Python/Flask)

```python
from flask import Flask, request, jsonify
import os

app = Flask(__name__)
WEBHOOK_SECRET = os.environ.get('ROOFING_API_KEY')

@app.route('/webhooks/roofing-api', methods=['POST'])
def handle_webhook():
    # Verify the webhook secret
    secret = request.headers.get('X-Webhook-Secret')
    if secret != WEBHOOK_SECRET:
        return 'Unauthorized', 401
    
    event = request.get_json()
    
    # Verify event structure
    if not all(k in event for k in ['event_type', 'timestamp', 'data']):
        return 'Bad Request', 400
    
    event_type = event['event_type']
    data = event['data']
    
    if event_type == 'stock.updated':
        handle_stock_update(data)
    elif event_type == 'webhook.test':
        print(f"Test webhook: {data['message']}")
    else:
        print(f"Unknown event type: {event_type}")
    
    return 'OK', 200

def handle_stock_update(data):
    print(f"Stock update for {data['sku']}:")
    print(f"  Previous: {data['previous_stock']}")
    print(f"  Current: {data['current_stock']}")
    # Update your database, notify customers, etc.

if __name__ == '__main__':
    app.run(port=3000)
```

## Retry Policy

If your webhook endpoint returns a non-2xx status code or times out, the API will retry delivery:

| Attempt | Delay |
|---------|-------|
| 1st | Immediate |
| 2nd | 5 seconds |
| 3rd | 25 seconds |

After 3 failed attempts, the webhook is marked as failed in the logs and can be reviewed by administrators.

## Best Practices

1. **Respond quickly** - Return 200 OK within 5 seconds
2. **Process asynchronously** - Queue events for background processing
3. **Implement idempotency** - Use `product_id` + `last_updated` to prevent duplicate processing
4. **Log everything** - Keep records of received webhooks for debugging
5. **Monitor failures** - Check webhook logs regularly for failed deliveries
