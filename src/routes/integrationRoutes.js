const router = require('express').Router();
const controller = require('../controllers/integrationController');

router.get('/', controller.listIntegrations);
router.put('/:key', controller.saveIntegration);
router.post('/:key/test', controller.testIntegration);
router.get('/logs/all', controller.getLogs);

module.exports = router;
