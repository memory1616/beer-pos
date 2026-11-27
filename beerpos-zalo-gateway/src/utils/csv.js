/**
 * Parse CSV nhe — KHONG them dependency ngoài.
 * Ho tro: truong dau tien, trich dan, escape "", dong CRLF, BOM.
 */

/**
 * @param {string} text - noi dung CSV
 * @returns {{headers: string[], rows: string[][], errors: {line:number, message:string}[]}}
 */
function parseCsv(text) {
  const errors = [];
  let raw = String(text || '');
  if (!raw.trim()) {
    return { headers: [], rows: [], errors };
  }

  // BOM
  if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);

  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  let line = 1;
  let started = false;

  const pushField = () => {
    row.push(field);
    field = '';
  };
  const pushRow = () => {
    pushField();
    // Bo dong rong
    if (row.length === 1 && row[0].trim() === '') {
      row = [];
      return;
    }
    rows.push({ cells: row, line });
    row = [];
  };

  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i];
    started = true;

    if (inQuotes) {
      if (ch === '"') {
        if (raw[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        if (ch === '\n') line += 1;
        field += ch;
      }
      continue;
    }

    if (ch === '"' && field === '') {
      inQuotes = true;
      continue;
    }
    if (ch === ',') {
      pushField();
      continue;
    }
    if (ch === '\r') continue;
    if (ch === '\n') {
      pushRow();
      line += 1;
      started = false;
      continue;
    }
    field += ch;
  }

  if (started && (field.length || row.length)) pushRow();

  if (inQuotes) {
    errors.push({ line, message: 'Chuoi trich dan khong dong' });
  }

  if (!rows.length) return { headers: [], rows: [], errors };

  const headerRow = rows.shift();
  const headers = headerRow.cells.map((h) => h.trim().toLowerCase().replace(/^\ufeff/, ''));
  const dataRows = rows.map((r) => ({ cells: r.cells, line: r.line }));

  return { headers, rows: dataRows, errors };
}

/**
 * Chuyen hang CSV thanh object theo header.
 * @param {string[]} headers
 * @param {string[]} cells
 */
function rowToObject(headers, cells) {
  const obj = {};
  headers.forEach((h, i) => {
    obj[h] = (cells[i] === undefined ? '' : String(cells[i]).trim());
  });
  return obj;
}

module.exports = { parseCsv, rowToObject };
