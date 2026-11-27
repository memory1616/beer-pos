const GroupRepository = require('../database/repositories/GroupRepository');
const AuditService = require('./AuditService');
const { parseCsv, rowToObject } = require('../utils/csv');
const { config } = require('../config');
const { badRequest, conflict, notFound } = require('../utils/errors');

const { AUDIT_ACTIONS } = AuditService;

const REQUIRED_HEADERS = ['customerid', 'groupid'];
const OPTIONAL_HEADERS = ['customername', 'groupname', 'note'];

/**
 * GroupService — quan ly mapping 1 khach hang <-> 1 nhom Zalo.
 *
 * Quy tac (enforce o CA service layer VA DB layer):
 *  1. 1 Customer ID chi co 1 Group ID active.
 *  2. 1 Group ID chi thuoc 1 Customer ID.
 *  3. Khong cho trung Group ID.
 *  4. Khong cho Group ID rong.
 *  5. Xoa mapping khong xoa lich su gui tin.
 *  6. Khach khong hoat dong -> khong gui thong bao moi.
 *  7. Khong tu tao nhom Zalo.
 *  8. Khong dong bo danh sach hoi thoai Zalo.
 */
class GroupService {
  constructor(repos) {
    this.repo = (repos && repos.groups) || new GroupRepository();
    this.audit = (repos && repos.audit) || new AuditService();
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  _validateCore({ customerId, groupId }) {
    const errors = [];

    const cid = String(customerId || '').trim();
    const gid = String(groupId || '').trim();

    if (!cid) {
      errors.push({ field: 'customerId', message: 'Thieu Customer ID' });
    } else if (cid.length > config.limits.maxCustomerIdLength) {
      errors.push({ field: 'customerId', message: 'Customer ID qua dai' });
    }

    if (!gid) {
      errors.push({ field: 'groupId', message: 'Thieu Group ID' });
    } else if (gid.length > config.limits.maxGroupIdLength) {
      errors.push({ field: 'groupId', message: 'Group ID qua dai' });
    }

    if (errors.length) {
      throw badRequest(errors.map((e) => e.message).join('; '), 'VALIDATION_ERROR', {
        errors,
      });
    }

    return { customerId: cid, groupId: gid };
  }

  _validateOptional({ customerName, groupName, note }) {
    const errors = [];
    if (customerName && String(customerName).length > config.limits.maxNameLength) {
      errors.push({ field: 'customerName', message: 'Ten khach hang qua dai' });
    }
    if (groupName && String(groupName).length > config.limits.maxNameLength) {
      errors.push({ field: 'groupName', message: 'Ten nhom qua dai' });
    }
    if (note && String(note).length > config.limits.maxNoteLength) {
      errors.push({ field: 'note', message: 'Ghi chu qua dai' });
    }
    if (errors.length) {
      throw badRequest(errors.map((e) => e.message).join('; '), 'VALIDATION_ERROR', {
        errors,
      });
    }
  }

  // ── Read ──────────────────────────────────────────────────────────────────

  list(opts = {}) {
    const res = this.repo.list(opts);
    return {
      total: res.total,
      page: res.page,
      limit: res.limit,
      items: res.items.map((r) => this._toDto(r)),
    };
  }

  getById(id) {
    const row = this.repo.findById(id);
    if (!row) throw notFound('Khong tim thay lien ket', 'GROUP_NOT_FOUND');
    return this._toDto(row);
  }

  /** Tra mapping ACTIVE theo customerId (dung khi gui tin). */
  findActive(customerId) {
    const row = this.repo.findActiveByCustomerId(customerId);
    return row ? this._toDto(row) : null;
  }

  _toDto(row) {
    return {
      id: row.id,
      customerId: row.customer_id,
      customerName: row.customer_name,
      groupId: row.group_id,
      groupName: row.group_name,
      note: row.note,
      isActive: !!row.is_active,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  // ── Write ─────────────────────────────────────────────────────────────────

  create(input = {}) {
    const { customerId, groupId } = this._validateCore(input);
    this._validateOptional(input);

    const existingCustomer = this.repo.findByCustomerId(customerId);
    if (existingCustomer) {
      if (existingCustomer.is_active) {
        throw conflict(
          `Customer ID "${customerId}" da co lien ket nhom`,
          'DUPLICATE_CUSTOMER'
        );
      }
      throw conflict(
        `Customer ID "${customerId}" co lien ket dang inactive - hay kich hoat lai thay vi them moi`,
        'INACTIVE_EXISTS'
      );
    }

    const existingGroup = this.repo.findByGroupId(groupId);
    if (existingGroup) {
      throw conflict(
        `Group ID "${groupId}" da duoc lien ket voi khach hang khac`,
        'DUPLICATE_GROUP'
      );
    }

    let created;
    try {
      created = this.repo.insert({
        customerId,
        customerName: input.customerName ? String(input.customerName).trim() : null,
        groupId,
        groupName: input.groupName ? String(input.groupName).trim() : null,
        note: input.note ? String(input.note).trim() : null,
        isActive: true,
      });
    } catch (e) {
      if (String(e.message).includes('UNIQUE')) {
        throw conflict('Customer ID hoac Group ID da ton tai', 'DUPLICATE');
      }
      throw e;
    }

    this.audit.record({
      action: AUDIT_ACTIONS.GROUP_CREATE,
      entityType: 'group',
      entityId: created.id,
      details: { customerId, groupId, customerName: created.customer_name },
    });

    return this._toDto(created);
  }

  update(id, patch = {}) {
    const current = this.repo.findById(id);
    if (!current) throw notFound('Khong tim thay lien ket', 'GROUP_NOT_FOUND');

    const next = {
      customerId: patch.customerId !== undefined ? patch.customerId : current.customer_id,
      groupId: patch.groupId !== undefined ? patch.groupId : current.group_id,
      customerName:
        patch.customerName !== undefined ? patch.customerName : current.customer_name,
      groupName: patch.groupName !== undefined ? patch.groupName : current.group_name,
      note: patch.note !== undefined ? patch.note : current.note,
      isActive: patch.isActive !== undefined ? !!patch.isActive : !!current.is_active,
    };

    const { customerId, groupId } = this._validateCore(next);
    this._validateOptional(next);

    if (customerId !== current.customer_id) {
      const other = this.repo.findByCustomerId(customerId);
      if (other && other.id !== current.id) {
        throw conflict(
          `Customer ID "${customerId}" da co lien ket nhom khac`,
          'DUPLICATE_CUSTOMER'
        );
      }
    }
    if (groupId !== current.group_id) {
      const other = this.repo.findByGroupId(groupId);
      if (other && other.id !== current.id) {
        throw conflict(
          `Group ID "${groupId}" da duoc lien ket voi khach hang khac`,
          'DUPLICATE_GROUP'
        );
      }
    }

    let updated;
    try {
      updated = this.repo.update(id, {
        customerId,
        customerName: next.customerName ? String(next.customerName).trim() : null,
        groupId,
        groupName: next.groupName ? String(next.groupName).trim() : null,
        note: next.note ? String(next.note).trim() : null,
        isActive: next.isActive,
      });
    } catch (e) {
      if (String(e.message).includes('UNIQUE')) {
        throw conflict('Customer ID hoac Group ID da ton tai', 'DUPLICATE');
      }
      throw e;
    }

    this.audit.record({
      action: AUDIT_ACTIONS.GROUP_UPDATE,
      entityType: 'group',
      entityId: id,
      details: {
        before: {
          customerId: current.customer_id,
          groupId: current.group_id,
          isActive: !!current.is_active,
        },
        after: { customerId, groupId, isActive: next.isActive },
      },
    });

    return this._toDto(updated);
  }

  /** Soft delete - giu nguyen lich su gui tin. */
  deactivate(id) {
    const current = this.repo.findById(id);
    if (!current) throw notFound('Khong tim thay lien ket', 'GROUP_NOT_FOUND');
    if (!current.is_active) return this._toDto(current);

    const updated = this.repo.deactivate(id);
    this.audit.record({
      action: AUDIT_ACTIONS.GROUP_DEACTIVATE,
      entityType: 'group',
      entityId: id,
      details: { customerId: current.customer_id, groupId: current.group_id },
    });
    return this._toDto(updated);
  }

  delete(id) {
    return this.deactivate(id);
  }

  // ── CSV Import ────────────────────────────────────────────────────────────

  /**
   * Preview CSV khong ghi du lieu.
   * @param {string} csvText
   */
  previewCsv(csvText) {
    const parsed = this._parseImport(csvText);
    const seenCustomer = new Set();
    const seenGroup = new Set();
    const errors = [...parsed.errors];

    parsed.rows.forEach((row) => {
      const obj = rowToObject(parsed.headers, row.cells);
      const lineErrors = this._validateImportRow(obj);
      if (lineErrors.length) {
        errors.push({ line: row.line, ...lineErrors[0], customerId: obj.customerid });
        return;
      }
      // Trung trong file
      if (seenCustomer.has(obj.customerid.toLowerCase())) {
        errors.push({
          line: row.line,
          customerId: obj.customerid,
          message: 'Customer ID bi trung trong file CSV',
        });
        return;
      }
      if (seenGroup.has(obj.groupid)) {
        errors.push({
          line: row.line,
          customerId: obj.customerid,
          message: 'Group ID bi trung trong file CSV',
        });
        return;
      }
      seenCustomer.add(obj.customerid.toLowerCase());
      seenGroup.add(obj.groupid);
    });

    return {
      total: parsed.rows.length,
      valid: parsed.rows.length - errors.length,
      invalid: errors.length,
      errors,
    };
  }

  /**
   * Import CSV trong 1 transaction.
   * @param {string} csvText
   * @param {object} opts { dryRun }
   */
  importCsv(csvText, opts = {}) {
    const dryRun = opts.dryRun !== false;
    const parsed = this._parseImport(csvText);

    if (parsed.errors.length && !dryRun) {
      throw badRequest('File CSV khong hop le', 'INVALID_CSV', { errors: parsed.errors });
    }

    const seenCustomer = new Set();
    const seenGroup = new Set();
    const errors = [...parsed.errors];
    const validItems = [];

    parsed.rows.forEach((row) => {
      const obj = rowToObject(parsed.headers, row.cells);
      const lineErrors = this._validateImportRow(obj);
      if (lineErrors.length) {
        errors.push({ line: row.line, ...lineErrors[0], customerId: obj.customerid });
        return;
      }
      if (seenCustomer.has(obj.customerid.toLowerCase())) {
        errors.push({
          line: row.line,
          customerId: obj.customerid,
          message: 'Customer ID bi trung trong file CSV',
        });
        return;
      }
      if (seenGroup.has(obj.groupid)) {
        errors.push({
          line: row.line,
          customerId: obj.customerid,
          message: 'Group ID bi trung trong file CSV',
        });
        return;
      }
      seenCustomer.add(obj.customerid.toLowerCase());
      seenGroup.add(obj.groupid);
      validItems.push({ line: row.line, obj });
    });

    if (dryRun) {
      return {
        dryRun: true,
        total: parsed.rows.length,
        valid: validItems.length,
        invalid: errors.length,
        errors,
        items: validItems.map((i) => ({
          line: i.line,
          customerId: i.obj.customerid,
          groupId: i.obj.groupid,
          action: 'insert',
        })),
      };
    }

    // Kiem tra conflict voi DB hien tai (truocc khi ghi)
    const dbConflicts = [];
    validItems.forEach((item) => {
      const { customerid: cid, groupid: gid } = item.obj;
      const byCustomer = this.repo.findByCustomerId(cid);
      if (byCustomer && byCustomer.is_active) {
        dbConflicts.push({
          line: item.line,
          customerId: cid,
          groupId: gid,
          message: `Customer ID "${cid}" da co lien ket nhom trong he thong`,
        });
        return;
      }
      const byGroup = this.repo.findByGroupId(gid);
      if (byGroup) {
        dbConflicts.push({
          line: item.line,
          customerId: cid,
          groupId: gid,
          message: `Group ID "${gid}" dang thuoc ve khach hang khac`,
        });
      }
    });

    const conflictKeys = new Set(dbConflicts.map((c) => c.line));
    const toInsert = validItems.filter((i) => !conflictKeys.has(i.line));
    errors.push(...dbConflicts);

    let inserted = [];
    if (toInsert.length) {
      const { getDb } = require('../database/connection');
      const db = getDb();
      const insertOne = db.transaction((item) => {
        const o = item.obj;
        return this.repo.insert({
          customerId: o.customerid,
          customerName: o.customername || null,
          groupId: o.groupid,
          groupName: o.groupname || null,
          note: o.note || null,
          isActive: true,
        });
      });
      inserted = toInsert.map((item) => insertOne(item));
    }

    this.audit.record({
      action: AUDIT_ACTIONS.GROUP_IMPORT,
      entityType: 'group',
      entityId: null,
      details: {
        total: parsed.rows.length,
        inserted: inserted.length,
        skipped: errors.length,
      },
    });

    return {
      dryRun: false,
      total: parsed.rows.length,
      valid: toInsert.length,
      inserted: inserted.length,
      invalid: errors.length,
      errors,
      items: inserted.map((r) => ({
        id: r.id,
        customerId: r.customer_id,
        groupId: r.group_id,
      })),
    };
  }

  _parseImport(csvText) {
    const parsed = parseCsv(csvText);
    const headers = parsed.headers;
    const missing = REQUIRED_HEADERS.filter((h) => !headers.includes(h));
    if (missing.length) {
      throw badRequest(
        `CSV thieu cot bat buoc: ${missing.join(', ')}`,
        'INVALID_CSV',
        { errors: parsed.errors }
      );
    }
    if (parsed.rows.length > config.limits.maxImportRows) {
      throw badRequest(
        `CSV qua nhieu dong (toi da ${config.limits.maxImportRows})`,
        'CSV_TOO_LARGE'
      );
    }
    return { ...parsed, headers };
  }

  _validateImportRow(obj) {
    const errors = [];
    const cid = String(obj.customerid || '').trim();
    const gid = String(obj.groupid || '').trim();

    if (!cid) errors.push({ message: 'Thieu Customer ID' });
    if (!gid) errors.push({ message: 'Thieu Group ID' });
    if (cid && cid.length > config.limits.maxCustomerIdLength) {
      errors.push({ message: 'Customer ID qua dai' });
    }
    if (gid && gid.length > config.limits.maxGroupIdLength) {
      errors.push({ message: 'Group ID qua dai' });
    }
    if (obj.customername && obj.customername.length > config.limits.maxNameLength) {
      errors.push({ message: 'Ten khach hang qua dai' });
    }
    if (obj.groupname && obj.groupname.length > config.limits.maxNameLength) {
      errors.push({ message: 'Ten nhom qua dai' });
    }
    if (obj.note && obj.note.length > config.limits.maxNoteLength) {
      errors.push({ message: 'Ghi chu qua dai' });
    }
    return errors;
  }

  /** Mau CSV tai ve. */
  static csvTemplate() {
    return (
      'customerId,customerName,groupId,groupName,note\n' +
      'KH001,Quan A,GROUP001,Nhom Quan A,d lieu thu nghiem\n' +
      'KH002,Quan B,GROUP002,Nhom Quan B,d lieu thu nghiem\n' +
      'KH003,Quan C,GROUP003,Nhom Quan C,d lieu thu nghiem\n'
    );
  }
}

module.exports = GroupService;
module.exports.REQUIRED_HEADERS = REQUIRED_HEADERS;
module.exports.OPTIONAL_HEADERS = OPTIONAL_HEADERS;
