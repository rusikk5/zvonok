'use strict';

// Замените на URL вашего задеплоенного сервера (Railway/Render/VPS)
// После деплоя Railway даст URL вида: https://zvonok-production.up.railway.app
const PROD_SERVER_URL = process.env.ZVONOK_SERVER_URL || 'https://ВАШ_СЕРВЕР.up.railway.app';

module.exports = { PROD_SERVER_URL };
