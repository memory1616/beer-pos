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

### keg_log
- id (INTEGER PRIMARY KEY)
- customer_id (INTEGER)
- change (INTEGER) - positive for delivery, negative for return
- date (TEXT)
- note (TEXT)

## Important Notes

- Every keg transaction is logged in the `keg_log` table
- Customer keg_balance should only be used for display; always query `keg_log` for accurate history
- Custom prices are set per customer-product combination
- All sales transactions update stock, keg balance, and create log entries atomically

## Deployment on VPS (Hostinger)

1. Upload files to your VPS
2. Install Node.js on the VPS
3. Run `npm install`
4. Run `npm start`
5. Use PM2 or similar to keep the server running
6. Configure reverse proxy (nginx) to point to port 3000

## Default Data

The database is automatically seeded with:
- 4 sample beer products
- 3 sample customers
- Sample custom prices for each customer-product combination
