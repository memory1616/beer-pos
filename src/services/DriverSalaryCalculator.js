/**
 * DriverSalaryCalculator — Tính lương tài xế theo NGÀY LÀM
 * ─────────────────────────────────────────────────────────────────────────────
 * Công thức nghiệp vụ:
 *
 *      lương_1_ngày  = lương_cơ_bản_tháng ÷ 26
 *      lương_theo_ngày = lương_1_ngày × số_ngày_làm_thực_tế
 *
 * Trong đó `số_ngày_làm_thực_tế`:
 *   - Bắt đầu từ MAX(ngày vào làm, ngày 1 của tháng tính)
 *   - Kết thúc tại MIN(ngày hiện tại, ngày cuối của tháng tính)
 *   - KHÔNG tính Chủ Nhật (mẫu số 26 = 26 ngày làm/tháng)
 *   - Nếu ngày vào làm chưa khai báo → tính từ đầu tháng
 *
 * Với tháng ĐANG HIỆN TẠI, số ngày làm được tính tới NGÀY HIỆN TẠI.
 * Với tháng ĐÃ QUA, số ngày làm = toàn bộ ngày làm trong tháng đó.
 */

const db = require('../../database');

// Mẫu số ngày làm chuẩn trong tháng (26 = 30 - 4 ngày nghỉ)
const STANDARD_WORK_DAYS = 26;

// ── Helper: ngày trong tuần (0 = Chủ Nhật, 6 = Thứ Bảy) ────────────────────
function dayOfWeek(dateStr) {
  // new Date('YYYY-MM-DD') được parse theo UTC → dùng getUTCDay() cho ổn định
  const d = new Date(dateStr + 'T00:00:00Z');
  return d.getUTCDay();
}

/** Ngày cuối của tháng (YYYY-MM-DD) */
function lastDayOfMonth(year, month) {
  return new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
}

/** Ngày đầu tháng (YYYY-MM-DD) */
function firstDayOfMonth(year, month) {
  return `${year}-${String(month).padStart(2, '0')}-01`;
}

/**
 * Tính số ngày làm thực tế trong khoảng [from, to] (bao gồm 2 đầu).
 * Bỏ qua Chủ Nhật.
 *
 * @param {string} from  YYYY-MM-DD
 * @param {string} to    YYYY-MM-DD
 * @returns {number}
 */
function countWorkingDays(from, to) {
  if (!from || !to || from > to) return 0;

  const start = new Date(from + 'T00:00:00Z');
  const end = new Date(to + 'T00:00:00Z');
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return 0;

  let count = 0;
  const ONE_DAY = 24 * 60 * 60 * 1000;
  // Giới hạn 400 ngày để tránh vòng lặp vô hạn nếu dữ liệu rác
  const maxIter = 400;

  for (let i = 0; i <= maxIter; i++) {
    const cur = new Date(start.getTime() + i * ONE_DAY);
    if (cur.getTime() > end.getTime()) break;
    if (cur.getUTCDay() !== 0) count++; // bỏ Chủ Nhật
  }
  return count;
}

/**
 * Tính chi tiết lương theo ngày làm cho 1 tài xế trong 1 kỳ.
 *
 * @param {object} driver  row từ driver_staff (cần id, start_date, monthly_salary)
 * @param {number} year
 * @param {number} month
 * @param {object} opts
 * @param {string} [opts.today]   ngày hiện tại (YYYY-MM-DD), mặc định lấy từ DB
 * @param {number} [opts.baseSalary]  lương cơ bản dùng để tính (mặc định monthly_salary)
 * @param {boolean} [opts.manualWorkDays] số ngày làm do admin sửa tay (bỏ qua tính tự động)
 * @param {number} [opts.manualWorkDays]
 * @returns {{
 *   startDate: string|null,
 *   periodStart: string,
 *   periodEnd: string,
 *   isCurrentMonth: boolean,
 *   workDays: number,
 *   standardWorkDays: number,
 *   dailyRate: number,
 *   baseSalary: number,
 *   proratedBase: number
 * }}
 */
function calculate(driver, year, month, opts = {}) {
  const today = opts.today || db.getVietnamDateStr();
  const periodStart = firstDayOfMonth(year, month);
  const periodEnd = lastDayOfMonth(year, month);

  const isCurrentMonth = today.slice(0, 7) === `${year}-${String(month).padStart(2, '0')}`;

  // Ngày vào làm (có thể NULL → tính từ đầu tháng)
  const startDate = driver && driver.start_date ? String(driver.start_date).slice(0, 10) : null;

  // ── Khoảng tính trong tháng ──
  // Nếu ngày vào làm SAU ngày cuối kỳ → tài xế chưa bắt đầu làm trong tháng đó
  if (startDate && startDate > periodEnd) {
    return {
      startDate,
      periodStart,
      periodEnd,
      isCurrentMonth,
      workDays: 0,
      standardWorkDays: STANDARD_WORK_DAYS,
      dailyRate: 0,
      baseSalary: 0,
      proratedBase: 0,
    };
  }

  // Bắt đầu: không sớm hơn đầu tháng, không trước ngày vào làm
  let from = periodStart;
  if (startDate && startDate > from) from = startDate;

  // Kết thúc: tháng hiện tại → tới hôm nay; tháng quá → hết tháng
  let to = periodEnd;
  if (isCurrentMonth) {
    to = today < periodEnd ? today : periodEnd;
  }
  // Ngày vào làm sau ngày kết thúc → không có ngày làm
  if (from > to) from = to;

  // Số ngày làm (bỏ Chủ Nhật)
  let workDays;
  if (opts.manualWorkDays !== undefined && opts.manualWorkDays !== null && opts.manualWorkDays !== '') {
    workDays = Math.max(0, Math.floor(Number(opts.manualWorkDays) || 0));
  } else {
    workDays = countWorkingDays(from, to);
  }

  const baseSalary = Number(
    opts.baseSalary !== undefined && opts.baseSalary !== null && opts.baseSalary !== ''
      ? opts.baseSalary
      : (driver && driver.monthly_salary) || 0
  ) || 0;

  const dailyRate = baseSalary / STANDARD_WORK_DAYS;
  const proratedBase = Math.round(dailyRate * workDays);

  return {
    startDate,
    periodStart,
    periodEnd,
    isCurrentMonth,
    workDays,
    standardWorkDays: STANDARD_WORK_DAYS,
    dailyRate,
    baseSalary,
    proratedBase,
  };
}

module.exports = {
  calculate,
  countWorkingDays,
  dayOfWeek,
  firstDayOfMonth,
  lastDayOfMonth,
  STANDARD_WORK_DAYS,
};
