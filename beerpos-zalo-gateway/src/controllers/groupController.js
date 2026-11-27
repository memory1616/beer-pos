const GroupService = require('../services/GroupService');
const { validateGroupBody, parsePaging } = require('../validators');
const { badRequest } = require('../utils/errors');

/** Doc noi dung CSV tu request (raw text hoac JSON). */
function readCsv(req) {
  let csv = '';
  if (typeof req.body === 'string') csv = req.body;
  else if (req.body && typeof req.body.csv === 'string') csv = req.body.csv;
  if (!csv.trim()) {
    throw badRequest(
      'Khong nhan duoc noi dung CSV. Gui body dang text/csv hoac JSON { csv: "..." }',
      'VALIDATION_ERROR'
    );
  }
  return csv;
}

function makeController(repos) {
  const groups = (repos && repos.groups) || new GroupService();

  return {
    async list(req, res) {
      const { page, limit } = parsePaging(req.query);
      const result = groups.list({
        search: req.query.search,
        status: req.query.status || 'all',
        page,
        limit,
      });
      res.json({ success: true, ...result });
    },

    async getById(req, res) {
      res.json({ success: true, group: groups.getById(req.params.id) });
    },

    async create(req, res) {
      validateGroupBody(req.body);
      const group = groups.create(req.body);
      res.status(201).json({ success: true, group });
    },

    async update(req, res) {
      validateGroupBody(req.body, { partial: true });
      const group = groups.update(req.params.id, req.body);
      res.json({ success: true, group });
    },

    async remove(req, res) {
      const group = groups.deactivate(req.params.id);
      res.json({ success: true, deactivated: true, group });
    },

    /** Preview CSV (khong ghi du lieu). */
    async previewImport(req, res) {
      const result = groups.previewCsv(readCsv(req));
      res.json({ success: true, ...result });
    },

    /** Import CSV that (transaction). */
    async importCsv(req, res) {
      const csv = readCsv(req);
      const dryRun =
        String(req.query.dryRun || (req.body && req.body.dryRun) || 'false').toLowerCase() !==
        'false';
      const result = groups.importCsv(csv, { dryRun });
      res.json({ success: true, ...result });
    },

    /** Tai file mau CSV. */
    async template(req, res) {
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', 'attachment; filename="gateway-groups-template.csv"');
      res.send(GroupService.csvTemplate());
    },
  };
}

module.exports = { makeController };
