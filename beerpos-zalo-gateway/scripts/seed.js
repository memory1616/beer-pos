#!/usr/bin/env node
/**
 * Script seed - them du lieu mau.
 * Tat ca ban ghi deu co note "du lieu thu nghiem" de nhan biet & don de.
 */
const { migrate } = require('../src/database/migrator');
const { closeDb } = require('../src/database/connection');
const GroupService = require('../src/services/GroupService');
const logger = require('../src/logger');

const SEED = [
  {
    customerId: 'KH001',
    customerName: 'Quán A',
    groupId: 'GROUP001',
    groupName: 'Nhóm Quán A',
    note: 'dữ liệu thử nghiệm',
  },
  {
    customerId: 'KH002',
    customerName: 'Quán B',
    groupId: 'GROUP002',
    groupName: 'Nhóm Quán B',
    note: 'dữ liệu thử nghiệm',
  },
  {
    customerId: 'KH003',
    customerName: 'Quán C',
    groupId: 'GROUP003',
    groupName: 'Nhóm Quán C',
    note: 'dữ liệu thử nghiệm',
  },
];

function main() {
  migrate();
  const service = new GroupService();

  let created = 0;
  let skipped = 0;

  SEED.forEach((row) => {
    try {
      service.create(row);
      created += 1;
      console.log(`[SEED] Da them ${row.customerId} -> ${row.groupId}`);
    } catch (e) {
      if (['DUPLICATE_CUSTOMER', 'DUPLICATE_GROUP', 'INACTIVE_EXISTS'].includes(e.code)) {
        skipped += 1;
        console.log(`[SEED] Bo qua ${row.customerId} (${e.code})`);
      } else {
        throw e;
      }
    }
  });

  console.log(`[SEED] Xong: ${created} them moi, ${skipped} bo qua.`);
  closeDb();
}

try {
  main();
} catch (e) {
  logger.error('[SEED] That bai', { error: e.message });
  console.error('[SEED] THAT BAI:', e.message);
  closeDb();
  process.exit(1);
}
