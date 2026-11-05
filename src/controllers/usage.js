'use strict';

/**
 * /usage：返回当月各服务商已用/剩余/占比与总量。
 */
async function usage(req, res, next) {
  try {
    const svc = req.app.locals.services.translate;
    const statuses = await svc.getStatuses();
    const month = new Date().toISOString().slice(0, 7);
    const totalUsed = statuses.reduce((s, p) => s + p.monthUsed, 0);
    res.json({ month, totalUsed, providers: statuses });
  } catch (e) {
    next(e);
  }
}

module.exports = { usage };
