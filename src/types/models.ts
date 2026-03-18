/**
 * Beer POS - Type Definitions
 * Centralized type definitions for all core models
 */

// ============= CORE MODELS =============

/** Sản phẩm/Bia */
export interface Product {
  id: string;
  name: string;
  price: number;
  category?: string;
  stock?: number;
  unit?: string;
}

/** Một dòng trong đơn hàng */
export interface OrderItem {
  productId: string;
  name: string;
  priceAtTime: number;
  quantity: number;
}

/** Đơn hàng */
export interface Order {
  id: string;
  customerId?: string;
  customerName?: string;
  items: OrderItem[];
  total: number;
  createdAt: number;
  paymentMethod?: 'cash' | 'transfer';
  note?: string;
}

/** Chi phí */
export interface Expense {
  id: string;
  type: 'fuel' | 'food' | 'repair' | 'other';
  amount: number;
  note?: string;
  createdAt: number;
  date?: string;
}

/** Phiên làm việc (ngày) */
export interface Session {
  id: string;
  date: string;
  orders: Order[];
  expenses: Expense[];
  totalRevenue?: number;
  totalExpense?: number;
  profit?: number;
}

// ============= ADDITIONAL TYPES =============

/** Loại chi phí */
export type ExpenseType = 'fuel' | 'food' | 'repair' | 'other';

/** Phương thức thanh toán */
export type PaymentMethod = 'cash' | 'transfer';

/** Trạng thái đơn hàng */
export type OrderStatus = 'pending' | 'completed' | 'cancelled';

/** Thống kê ngày */
export interface DayStats {
  revenue: number;
  units: number;
  profit: number;
  orderCount: number;
}

/** Thống kê tháng */
export interface MonthStats {
  revenue: number;
  units: number;
  profit: number;
  orderCount: number;
}

/** Thống kê kho */
export interface KegStats {
  inStock: number;
  atCustomers: number;
  total: number;
}

/** Chi phí theo loại */
export interface ExpensesByType {
  fuel: number;
  food: number;
  repair: number;
  other: number;
  total: number;
}

/** Dữ liệu dashboard */
export interface DashboardData {
  todayStats: DayStats;
  monthStats: MonthStats;
  todayUnits: { units: number };
  kegStats: KegStats;
  expenses?: {
    today: number;
    month: number;
    todayByType?: ExpensesByType;
  };
  lowStockProducts?: Product[];
  recentSales?: Order[];
}

/** Customer - Khách hàng */
export interface Customer {
  id: string;
  name: string;
  phone?: string;
  address?: string;
  deposit?: number;
  fridge?: {
    lying?: number;
    standing?: number;
  };
  prices?: Record<string, number>;
  lastOrderDate?: string;
  createdAt: number;
}

/** Device - Tủ lạnh */
export interface Device {
  id: string;
  customerId: string;
  type: 'lying' | 'standing';
  name?: string;
  createdAt: number;
}

/** Delivery - Giao hàng */
export interface Delivery {
  id: string;
  customerId: string;
  customerName: string;
  items: OrderItem[];
  status: 'pending' | 'completed' | 'cancelled';
  createdAt: number;
  completedAt?: number;
}

/** Purchase - Nhập hàng */
export interface Purchase {
  id: string;
  supplier?: string;
  items: Array<{
    productId: string;
    name: string;
    quantity: number;
    price: number;
  }>;
  total: number;
  createdAt: number;
}
