# Beer Distributor Management System

A simple, fast, and mobile-friendly beer keg distribution management system built with vanilla Node.js, Express, SQLite, and TailwindCSS.

## Features

- **Dashboard**: View total stock, customers, and kegs at customers
- **Customers**: Manage customers with deposit tracking and custom pricing
- **Products**: Manage beer products and stock levels
- **Sale**: Sell beer kegs with automatic price lookup and invoice generation
- **Stock In**: Add new kegs to inventory
- **Return Keg**: Process keg returns from customers

## Tech Stack

- **Server**: Node.js with Express.js
- **Database**: SQLite with better-sqlite3
- **Frontend**: HTML + TailwindCSS (via CDN)
- **Template Engine**: EJS

## Installation

1. Install dependencies:
```bash
npm install
```

2. Start the server:
```bash
npm start
```

3. Open browser at: http://localhost:3000

## Project Structure

```
Beer/
├── server.js          # Main Express server with all routes
├── database.js        # SQLite database setup and schema
├── package.json      # Dependencies
└── README.md         # This file
```

## Database Schema

### customers
- id (INTEGER PRIMARY KEY)
- name (TEXT)
- phone (TEXT)
- deposit (REAL) - deposit money from customer
- keg_balance (INTEGER) - kegs currently at customer

### products
- id (INTEGER PRIMARY KEY)
- name (TEXT)
- stock (INTEGER)

### prices
- id (INTEGER PRIMARY KEY)
- customer_id (INTEGER)
- product_id (INTEGER)
- price (REAL) - custom price per customer-product

### sales
- id (INTEGER PRIMARY KEY)
- customer_id (INTEGER)
- date (TEXT)
- total (REAL)

### sale_items
- id (INTEGER PRIMARY KEY)
- sale_id (INTEGER)
- product_id (INTEGER)
- quantity (INTEGER)
- price (REAL)

### keg_transactions_log
- id (INTEGER PRIMARY KEY)
- type (TEXT) — deliver, collect, import, adjust, sell_empty, gift
- quantity (INTEGER)
- exchanged / purchased (INTEGER)
- customer_id / customer_name (INTEGER / TEXT)
- inventory_after / empty_after / holding_after (INTEGER) — snapshot after transaction
- note (TEXT)
- date (TEXT)

## Important Notes

- Every keg movement is logged in the `keg_transactions_log` table
- `keg_stats` holds the current state; `keg_transactions_log` holds the history
- Customer keg_balance should only be used for display; always query `keg_transactions_log` for accurate history
- Custom prices are set per customer-product combination
- All sales transactions update stock, keg balance, and create log entries atomically

## Deployment on VPS (Hostinger)

### Cách khuyến nghị: Auto deploy bằng GitHub Actions

1. Trên VPS, clone repo vào `~/beer-pos`
2. Cài Node.js, `pm2`, và chạy app bằng `pm2 start ecosystem.config.js`
3. Đảm bảo file `deploy/deploy.sh` có quyền chạy: `chmod +x deploy/deploy.sh`
4. Cấu hình GitHub repository secrets:
   - `VPS_HOST`
   - `VPS_USER`
   - `VPS_PORT`
   - `VPS_SSH_KEY`
5. Mỗi lần push lên `main`, workflow `.github/workflows/deploy.yml` sẽ SSH vào VPS và chạy `./deploy/deploy.sh`
6. Workflow sẽ kiểm tra lại `pm2 status beer-pos` và `http://127.0.0.1:3000/health`

### Fallback: Webhook deploy riêng

Nếu cần trigger thủ công hoặc không dùng GitHub Actions, chạy `server/setup-webhook.sh` trên VPS để dựng webhook server riêng qua PM2.

## Default Data

The database is automatically seeded with:
- 4 sample beer products
- 3 sample customers
- Sample custom prices for each customer-product combination
