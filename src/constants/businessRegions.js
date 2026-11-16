/**
 * Danh mục khu vực kinh doanh — NGUỒN SỰ THẬT DUY NHẤT (Single Source of Truth)
 * ─────────────────────────────────────────────────────────────────────────────
 * 9 khu vực nội bộ theo ĐỊA BÀN CŨ (mã vùng kinh doanh), KHÔNG phải đơn vị
 * hành chính hiện hành:
 *
 *   TP. Tây Ninh · Hòa Thành · Tân Biên · Tân Châu · Bến Cầu
 *   Châu Thành · Gò Dầu · Trảng Bàng · Dương Minh Châu
 *
 * File này là nguồn duy nhất dùng để SEED bảng `business_regions` (migration 058).
 * Mọi thành phần khác (API, UI) đọc danh mục từ DB → không hardcode ở nhiều nơi.
 */

/**
 * Danh sách 9 khu vực kinh doanh (mã vùng nội bộ).
 * `code` = mã ổn định để tích hợp / báo cáo (KHÔNG đổi theo tên hiển thị).
 */
const DEFAULT_BUSINESS_REGIONS = [
  { name: 'TP. Tây Ninh',      code: 'TP_TAY_NINH',      order: 1 },
  { name: 'Hòa Thành',        code: 'HOA_THANH',        order: 2 },
  { name: 'Tân Biên',         code: 'TAN_BIEN',         order: 3 },
  { name: 'Tân Châu',         code: 'TAN_CHAU',         order: 4 },
  { name: 'Bến Cầu',          code: 'BEN_CAU',          order: 5 },
  { name: 'Châu Thành',        code: 'CHAU_THANH',       order: 6 },
  { name: 'Gò Dầu',           code: 'GO_DAU',           order: 7 },
  { name: 'Trảng Bàng',       code: 'TRANG_BANG',       order: 8 },
  { name: 'Dương Minh Châu',  code: 'DUONG_MINH_CHAU',  order: 9 },
];

/** Tên khu vực dùng để gợi ý khi địa chỉ khách hàng có chứa tên khu vực. */
const REGION_NAME_KEYWORDS = DEFAULT_BUSINESS_REGIONS.map((r) => r.name);

module.exports = {
  DEFAULT_BUSINESS_REGIONS,
  REGION_NAME_KEYWORDS,
};
