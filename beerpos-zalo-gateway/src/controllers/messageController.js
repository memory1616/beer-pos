const MessageService = require('../services/MessageService');
const QueueService = require('../services/QueueService');
const { validateMessageBody, parsePaging } = require('../validators');
const { badRequest } = require('../utils/errors');

function makeController(repos) {
  const messages = (repos && repos.messages) || new MessageService();
  const queue = (repos && repos.queue) || new QueueService();

  return {
    /**
     * POST /api/messages/send
     * KHONG gui tin trong request — chi tao job.
     */
    async send(req, res) {
      validateMessageBody(req.body);

      const idempotencyKey =
        req.headers['idempotency-key'] ||
        req.headers['x-idempotency-key'] ||
        (req.body && req.body.idempotencyKey);

      if (!idempotencyKey) {
        throw badRequest(
          'Thieu header Idempotency-Key',
          'VALIDATION_ERROR'
        );
      }

      const result = messages.accept(req.body, idempotencyKey);

      res.status(result.created ? 202 : 200).json({
        success: true,
        accepted: true,
        jobId: result.job.id,
        status: result.job.status,
        provider: result.job.provider,
        duplicate: !result.created,
      });
    },

    async history(req, res) {
      const { page, limit } = parsePaging(req.query);
      const result = messages.history({
        status: req.query.status,
        customerId: req.query.customerId,
        paymentId: req.query.paymentId,
        from: req.query.from,
        to: req.query.to,
        page,
        limit,
      });
      res.json({ success: true, ...result });
    },

    async jobDetail(req, res) {
      res.json({ success: true, ...messages.jobDetail(req.params.id) });
    },

    async retry(req, res) {
      const job = queue.retry(req.params.id, { reason: req.body?.reason });
      res.json({ success: true, jobId: job.id, status: job.status });
    },

    async cancel(req, res) {
      const job = queue.cancel(req.params.id, { reason: req.body?.reason });
      res.json({ success: true, jobId: job.id, status: job.status });
    },

    /** Thong ke hang doi. */
    async queueSummary(req, res) {
      const counts = queue.countsByStatus();
      res.json({ success: true, counts });
    },
  };
}

module.exports = { makeController };
