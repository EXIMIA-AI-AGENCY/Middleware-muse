'use strict';

// Vercel entrypoint: Vercel serves the Express app exported from app.js. Its framework
// detection requires this file to import express itself, hence the explicit require.
require('express');

module.exports = require('./src/vercel');
