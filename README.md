# Belgian Roofing Wholesalers API

## Render.com Deployment

1. Push to GitHub:
```bash
git remote add origin https://github.com/YOUR_USERNAME/belgian-roofing-api.git
git push -u origin master
```

2. Go to https://render.com and create a new Web Service

3. Connect your GitHub repo

4. Settings:
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
   - **Environment:** Node

5. Add environment variables:
   - `API_KEY` = demo-key
   - `ADMIN_KEY` = your-admin-key

6. Click "Create Web Service"

Your API will be live at `https://belgian-roofing-api.onrender.com`

## API Endpoints

| Endpoint | Description |
|----------|-------------|
| `GET /` | API info |
| `GET /v1/wholesalers` | List all |
| `GET /v1/wholesalers/search?q=` | Search |
| `GET /v1/wholesalers/:id` | Single company |
| `GET /v1/regions` | List regions |
| `GET /v1/stats` | Statistics |

## Auth

Use `?api_key=demo-key` or header `X-API-Key: demo-key`
