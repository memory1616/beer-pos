// ============================================================
// recovery.js — 报表数据恢复脚本
// 用途: 诊断 + 重建利润 + 补全缺失字段
// 使用: 浏览器控制台 或 <script src="/js/recovery.js"></script>
// ============================================================

(function () {
  'use strict';

  // ── 等待 DB 就绪 ────────────────────────────────────────────
  async function waitForDB() {
    if (window.dbReady) {
      try { await window.dbReady; } catch (e) { /* ignore */ }
    }
    if (!window.db) {
      throw new Error('[RECOVERY] window.db 不存在，请先加载 db.js');
    }
  }

  // ── 格式化金额 ────────────────────────────────────────────
  function fmt(n) {
    return new Intl.NumberFormat('vi-VN').format(n || 0) + ' đ';
  }

  // ══════════════════════════════════════════════════════════
  // TASK 1: 检查数据库健康状况
  // ══════════════════════════════════════════════════════════
  async function inspectDatabase() {
    await waitForDB();
    const db = window.db;

    console.group('[RECOVERY][TASK1] 数据库健康检查');
    console.log('=' .repeat(60));

    // 总览各表记录数
    const tableNames = ['sales', 'sale_items', 'products', 'customers', 'expenses'];
    for (const t of tableNames) {
      const count = db[t] ? await db[t].count() : -1;
      console.log('  ' + t.padEnd(12) + ': ' + count + ' 条');
    }

    // 加载所有销售单
    const allSales = await db.sales.toArray();
    console.log('\n销售单总数:', allSales.length);

    // 收集所有 sale_items（跨所有单）
    let allItems = [];
    if (db.sale_items) {
      const ids = allSales.map(s => s.id);
      if (ids.length > 0) {
        allItems = await db.sale_items.where('sale_id').anyOf(ids).toArray();
      }
    }
    console.log('销售明细总数:', allItems.length);

    // 诊断维度
    let missingProductId = 0;
    let missingCostPrice = 0;
    let missingProfit = 0;
    let missingProductName = 0;
    let saleMissingCustomerName = 0;

    for (const item of allItems) {
      if (item.product_id == null || item.product_id === '') missingProductId++;
      if (item.cost_price == null || item.cost_price === '') missingCostPrice++;
      if (item.profit == null || item.profit === undefined) missingProfit++;
      if (!item.product_name) missingProductName++;
    }

    for (const sale of allSales) {
      if (!sale.customer_name) saleMissingCustomerName++;
    }

    // 统计 sale.profit 缺失
    const saleMissingProfit = allSales.filter(s => s.profit == null || s.profit === undefined).length;

    console.log('\n--- sale_items 问题统计 ---');
    console.log('  缺失 product_id   :', missingProductId, '/', allItems.length);
    console.log('  缺失 cost_price    :', missingCostPrice, '/', allItems.length);
    console.log('  缺失 profit        :', missingProfit, '/', allItems.length);
    console.log('  缺失 product_name  :', missingProductName, '/', allItems.length);

    console.log('\n--- sales 问题统计 ---');
    console.log('  缺失 customer_name :', saleMissingCustomerName, '/', allSales.length);
    console.log('  缺失 profit        :', saleMissingProfit, '/', allSales.length);

    // 示例：打印前3条有问题的 item
    const problemItems = allItems.filter(it =>
      it.product_id == null || it.profit == null || it.cost_price == null
    ).slice(0, 5);
    if (problemItems.length > 0) {
      console.log('\n--- 问题 item 示例 (前5条) ---');
      problemItems.forEach(it => {
        console.log('  id:', it.id, '| sale_id:', it.sale_id,
          '| product_id:', it.product_id,
          '| price:', it.price,
          '| cost_price:', it.cost_price,
          '| profit:', it.profit,
          '| product_name:', it.product_name,
          '| quantity:', it.quantity);
      });
    }

    console.log('=' .repeat(60));
    console.groupEnd();

    return {
      totalSales: allSales.length,
      totalItems: allItems.length,
      missingProductId,
      missingCostPrice,
      missingProfit,
      missingProductName,
      saleMissingCustomerName,
      saleMissingProfit,
      allSales,
      allItems
    };
  }

  // ══════════════════════════════════════════════════════════
  // TASK 2: 重建利润（安全迁移，不删数据）
  // ══════════════════════════════════════════════════════════
  async function rebuildProfits() {
    await waitForDB();
    const db = window.db;

    console.group('[RECOVERY][TASK2] 重建利润');
    console.log('=' .repeat(60));

    const allSales = await db.sales.toArray();
    const ids = allSales.map(s => s.id);
    const allItems = ids.length > 0
      ? await db.sale_items.where('sale_id').anyOf(ids).toArray()
      : [];

    let fixedCount = 0;
    let estimatedCount = 0;
    let saleProfitRecalc = 0;
    let totalProfitRecalculated = 0;

    for (const item of allItems) {
      const originalProfit = item.profit;
      const price = Number(item.price) || 0;
      const costPrice = Number(item.cost_price) || 0;
      const quantity = Number(item.quantity) || 0;

      // 已有 profit 且为有效数字 → 跳过
      if (item.profit != null && item.profit !== '' && typeof item.profit === 'number' && !isNaN(item.profit)) {
        continue;
      }

      let newProfit = 0;
      let estimated = false;

      if (costPrice > 0 && price > 0) {
        newProfit = (price - costPrice) * quantity;
      } else {
        // 没有 cost_price：无法准确估算，设为 0 并标记
        newProfit = 0;
        estimated = true;
      }

      // 更新 item
      const updateData = { profit: newProfit };
      if (estimated) {
        updateData.profit_estimated = true;  // 标记为估算值
        estimatedCount++;
      } else {
        // 如果之前有 estimated 标记则清除
        updateData.profit_estimated = false;
      }

      await db.sale_items.update(item.id, updateData);
      fixedCount++;

      if (fixedCount <= 10) {
        console.log('  [修复] item.id=' + item.id + ' | 原profit=' + originalProfit +
          ' → 新profit=' + newProfit + (estimated ? ' [估算]' : ' [精确]'));
      }
    }

    // 重新计算每张 sales.profit = sum(item.profit)
    for (const sale of allSales) {
      const saleItems = allItems.filter(it => it.sale_id === sale.id);
      const computedProfit = saleItems.reduce((sum, it) => sum + (Number(it.profit) || 0), 0);

      if (sale.profit !== computedProfit) {
        await db.sales.update(sale.id, { profit: computedProfit });
        saleProfitRecalc++;
        totalProfitRecalculated += computedProfit;
      }
    }

    console.log('\n修复统计:');
    console.log('  精确计算 profit :', fixedCount - estimatedCount, '条');
    console.log('  估算 profit     :', estimatedCount, '条');
    console.log('  更新 sale.profit:', saleProfitRecalc, '条');
    console.log('  重新计算的利润总额:', fmt(totalProfitRecalculated));

    if (fixedCount > 10) {
      console.log('  ... (还有', fixedCount - 10, '条已静默修复)');
    }

    console.log('=' .repeat(60));
    console.groupEnd();

    return { fixedCount, estimatedCount, saleProfitRecalc };
  }

  // ══════════════════════════════════════════════════════════
  // TASK 3: 快照降级填充（product_name / customer_name）
  // ══════════════════════════════════════════════════════════
  async function fillSnapshots() {
    await waitForDB();
    const db = window.db;

    console.group('[RECOVERY][TASK3] 快照降级填充');
    console.log('=' .repeat(60));

    const allSales = await db.sales.toArray();
    const ids = allSales.map(s => s.id);
    const allItems = ids.length > 0
      ? await db.sale_items.where('sale_id').anyOf(ids).toArray()
      : [];

    // ── 3a: 为 sale_items 补全 product_name ─────────────────
    // 构建 product_id → name 的快速查询映射
    const productMap = {};
    const allProducts = db.products ? await db.products.toArray() : [];
    for (const p of allProducts) {
      productMap[p.id] = p.name || ('Sản phẩm #' + p.id);
    }

    let filledProductName = 0;
    for (const item of allItems) {
      if (!item.product_name) {
        const name = productMap[item.product_id] || ('Sản phẩm #' + item.product_id) || 'Unknown Product';
        await db.sale_items.update(item.id, { product_name: name });
        filledProductName++;
      }
    }
    console.log('sale_items 补全 product_name:', filledProductName, '条');

    // ── 3b: 为 sale_items 补全 sell_price（如果缺失）─────────
    let filledSellPrice = 0;
    for (const item of allItems) {
      if (item.price == null || item.price === '') {
        // 尝试从 products 表获取 sell_price
        const product = allProducts.find(p => p.id === item.product_id);
        const sellPrice = product && product.sell_price != null ? product.sell_price : 0;
        await db.sale_items.update(item.id, { price: sellPrice });
        filledSellPrice++;
      }
    }
    console.log('sale_items 补全 sell_price:', filledSellPrice, '条');

    // ── 3c: 为 sales 补全 customer_name ───────────────────
    const customerMap = {};
    const allCustomers = db.customers ? await db.customers.toArray() : [];
    for (const c of allCustomers) {
      customerMap[c.id] = c.name || 'Khách hàng #' + c.id;
    }

    let filledCustomerName = 0;
    for (const sale of allSales) {
      if (!sale.customer_name && sale.customer_id) {
        const name = customerMap[sale.customer_id] || 'Khách hàng #' + sale.customer_id;
        await db.sales.update(sale.id, { customer_name: name });
        filledCustomerName++;
      } else if (!sale.customer_name && !sale.customer_id) {
        // 无客户 → 标记为 Khách lẻ
        await db.sales.update(sale.id, { customer_name: 'Khách lẻ' });
        filledCustomerName++;
      }
    }
    console.log('sales 补全 customer_name:', filledCustomerName, '条');

    // ── 3d: 确保 sale_items 有 cost_price（从 products 读取）─
    let filledCostPrice = 0;
    for (const item of allItems) {
      if (item.cost_price == null || item.cost_price === '') {
        const product = allProducts.find(p => p.id === item.product_id);
        const cp = product && product.cost_price != null ? product.cost_price : 0;
        await db.sale_items.update(item.id, { cost_price: cp });
        filledCostPrice++;
      }
    }
    console.log('sale_items 补全 cost_price (from products):', filledCostPrice, '条');

    console.log('=' .repeat(60));
    console.groupEnd();

    return { filledProductName, filledCustomerName, filledSellPrice, filledCostPrice };
  }

  // ══════════════════════════════════════════════════════════
  // TASK 4: 完整恢复流程（依次执行所有任务）
  // ══════════════════════════════════════════════════════════
  async function runFullRecovery() {
    console.clear();
    console.log('%c[RECOVERY] 开始完整恢复流程', 'color:#ff9800;font-weight:bold;font-size:14px');
    console.log('─'.repeat(60));

    const t0 = Date.now();

    // Step 1: 诊断
    const inspect = await inspectDatabase();

    // Step 2: 重建利润
    const rebuilt = await rebuildProfits();

    // Step 3: 快照降级填充
    const filled = await fillSnapshots();

    // Step 4: 再次诊断，验证结果
    console.log('\n%c[RECOVERY] 恢复完成 → 最终诊断', 'color:#4caf50;font-weight:bold');
    const final = await inspectDatabase();

    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    console.log('\n%c总耗时: ' + elapsed + 's', 'color:#2196f3');

    // 汇总摘要
    console.group('[RECOVERY] 汇总摘要');
    console.log('修复的 item.profit          :', rebuilt.fixedCount, '条 (估算', rebuilt.estimatedCount, '条)');
    console.log('重新计算的 sale.profit       :', rebuilt.saleProfitRecalc, '条');
    console.log('补全 item.product_name       :', filled.filledProductName, '条');
    console.log('补全 sale.customer_name      :', filled.filledCustomerName, '条');
    console.log('补全 item.cost_price         :', filled.filledCostPrice, '条');
    console.log('补全 item.sell_price        :', filled.filledSellPrice, '条');
    console.log('');
    console.log('修复前问题:');
    console.log('  item.profit 缺失:', inspect.missingProfit, '→', final.missingProfit);
    console.log('  item.product_name 缺失:', inspect.missingProductName, '→', final.missingProductName);
    console.log('  sale.customer_name 缺失:', inspect.saleMissingCustomerName, '→', final.saleMissingCustomerName);
    console.groupEnd();

    return { inspect, rebuilt, filled, final };
  }

  // ── 暴露全局 API ─────────────────────────────────────────
  window.__recovery = {
    inspectDatabase,
    rebuildProfits,
    fillSnapshots,
    runFullRecovery
  };

  console.log('[RECOVERY] 脚本已加载. 调用方式:');
  console.log('  window.__recovery.inspectDatabase()  — 诊断');
  console.log('  window.__recovery.runFullRecovery()  — 完整恢复（推荐）');
})();
