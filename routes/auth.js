// routes/auth.js — 身份驗證中介軟體
// 供 routes/memory-api.js 等需要登入保護的路由使用。
// 登入態由 index.js 的 express-session 維護（登入成功設 req.session.authenticated = true）。

function requireAuth(req, res, next) {
    if (req.session && req.session.authenticated) return next();
    res.redirect('/login');
}

module.exports = { requireAuth };
