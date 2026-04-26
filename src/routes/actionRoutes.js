const router = require('express').Router();
const controller = require('../controllers/actionController');

router.post('/whatsapp/send', controller.sendWhatsAppFromActionPanel);

module.exports = router;
