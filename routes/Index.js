const express = require('express');
const userRoutes = require('./Routes');

const router = express.Router();

router.use('/', userRoutes);

module.exports = router;
